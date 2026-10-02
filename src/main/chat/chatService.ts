/**
 * 通常チャット（要件 6.4、6.14）
 * 応答はストリーミングで受け取り、差分をまとめて renderer に通知する。
 *
 * 履歴の送り方（思考ブロックは、それを生成した会話に結び付いている）:
 *   - 完了した応答は API の内容ブロックをそのまま保存し、変更せずに送り返す
 *   - 停止・エラーの応答は本文だけを送る（途中で切れた思考ブロックには署名が無い）
 *   - カスタム指示の変更やモデルの切り替えで整合しなくなった思考ブロックは、API 側で捨てて続行させる
 *     （prefix_mismatch_behavior: drop_block）
 */

import type Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { activePath } from '@shared/conversation'
import { resolveModel } from '@shared/models'
import type {
  AttachmentInfo,
  ChatEvent,
  EditAndResendInput,
  Message,
  Project,
  SendMessageInput,
  SendResult,
  Thread
} from '@shared/types'
import type { ClientFactory } from '../api/client'
import { API_ERROR_MESSAGES, toApiRequestError } from '../api/errors'
import * as ops from '../db/operations'
import type { ModelService } from '../models/modelService'
import { ATTACHMENT_LIMITS, kindOfMime, toContentBlock, type AttachmentStore } from './attachments'
import { estimateCost, type TokenUsage } from './pricing'

const { ValidationError } = ops

/** 最大のリトライ回数（6.14） */
export const MAX_RETRIES = 3
const RETRYABLE = new Set(['rate_limit', 'overloaded', 'server', 'timeout'])
const MAX_WAIT_MS = 60_000
const DEFAULT_MAX_TOKENS = 64_000
const THINKING_BETA = 'thinking-binding-controls-2026-08-01'
const TITLE_LENGTH = 40

export interface ChatServiceDeps {
  db: Database.Database
  attachments: AttachmentStore
  modelService: ModelService
  getApiKey: () => string | null
  createClient: ClientFactory
  emit: (event: ChatEvent) => void
  /** テストで待ち時間を短縮するために差し替える */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  flushIntervalMs?: number
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    })
  })

function retryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: Headers | null }).headers
  const value = headers?.get?.('retry-after')
  const seconds = value ? Number(value) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

type ContentBlock = { type: string; text?: string; thinking?: string }

function thinkingOf(record: ops.MessageRecord): string | null {
  if (!record.content_blocks) return null
  const text = (JSON.parse(record.content_blocks) as ContentBlock[])
    .filter((b) => b.type === 'thinking' && b.thinking)
    .map((b) => b.thinking)
    .join('\n\n')
  return text || null
}

const toInfo = (a: ops.AttachmentRecord): AttachmentInfo => ({
  id: a.id,
  filename: a.filename,
  mime_type: a.mime_type,
  size_bytes: a.size_bytes,
  kind: kindOfMime(a.mime_type)
})

export class ChatService {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>

  constructor(private readonly deps: ChatServiceDeps) {
    this.sleep = deps.sleep ?? abortableSleep
  }

  // ========================================
  // 公開操作
  // ========================================

  /** スレッドのメッセージ（分岐履歴を含む。表示する一続きは activePath で求める） */
  listMessages(threadId: string): Message[] {
    const attachments = this.attachmentsByMessage(threadId)
    return ops
      .listMessagesByThread(this.deps.db, threadId)
      .map((r) => this.toPublic(r, attachments.get(r.id) ?? []))
  }

  send(input: SendMessageInput): SendResult {
    const { thread, project, model } = this.prepare(input.threadId)
    this.checkNewContent(input.content, input.attachmentIds.length)
    const parent = activePath(ops.listMessagesByThread(this.deps.db, thread.id)).at(-1) ?? null

    const userMessage = this.createUserMessage(thread.id, parent?.id ?? null, input.content, () =>
      this.deps.attachments.getStaged(input.attachmentIds)
    )
    const committed = this.deps.attachments.commit(userMessage.id, input.attachmentIds)
    for (const record of committed) ops.insertAttachment(this.deps.db, record)

    if (thread.title === null) this.setTitle(thread.id, input.content)
    const assistantMessage = this.startGeneration(project, thread.id, userMessage.id, model)
    return { userMessage: this.getPublic(userMessage.id), assistantMessage }
  }

  /** 最新のユーザーメッセージに対する応答を作り直す（停止・エラー後の再試行） */
  regenerate(userMessageId: string): Message {
    const user = this.latestUserMessage(userMessageId)
    const { project, model } = this.prepare(user.thread_id)
    return this.startGeneration(project, user.thread_id, user.id, model)
  }

  /**
   * 最新のユーザーメッセージを編集して再送信する（CHT-14）
   * 元のメッセージと応答は分岐履歴として残し、同じ親の下に新しいメッセージを作る。
   */
  editAndResend(input: EditAndResendInput): SendResult {
    const original = this.latestUserMessage(input.userMessageId)
    const { project, model } = this.prepare(original.thread_id)
    const existing = this.attachmentsByMessage(original.thread_id).get(original.id) ?? []
    const kept = existing.filter((a) => input.keepAttachmentIds.includes(a.id))
    this.checkNewContent(input.content, kept.length + input.attachmentIds.length)

    const userMessage = this.createUserMessage(
      original.thread_id,
      original.parent_id,
      input.content,
      () => [...kept.map(toInfo), ...this.deps.attachments.getStaged(input.attachmentIds)]
    )
    for (const source of kept) {
      ops.insertAttachment(this.deps.db, this.deps.attachments.copyTo(userMessage.id, source))
    }
    for (const record of this.deps.attachments.commit(userMessage.id, input.attachmentIds)) {
      ops.insertAttachment(this.deps.db, record)
    }

    const assistantMessage = this.startGeneration(
      project,
      original.thread_id,
      userMessage.id,
      model
    )
    return { userMessage: this.getPublic(userMessage.id), assistantMessage }
  }

  /** 生成を停止する（CHT-04: 停止時点までの応答は保持する） */
  stop(threadId: string): void {
    this.running.get(threadId)?.controller.abort()
  }

  isGenerating(threadId: string): boolean {
    return this.running.has(threadId)
  }

  activeThreadIds(): string[] {
    return [...this.running.keys()]
  }

  /** 生成の完了を待つ（テスト・終了処理用） */
  async whenIdle(threadId?: string): Promise<void> {
    const targets = threadId
      ? [this.running.get(threadId)?.done]
      : [...this.running.values()].map((r) => r.done)
    await Promise.all(targets)
  }

  /** 起動時: 前回生成中のまま終了した応答を「中断」にする（6.14） */
  recoverInterrupted(): number {
    return ops.markStreamingInterrupted(this.deps.db)
  }

  // ========================================
  // 送信前の確認
  // ========================================

  private prepare(threadId: string): { thread: Thread; project: Project; model: string } {
    if (this.deps.getApiKey() === null) {
      throw new ValidationError('API キーが設定されていません。設定画面で登録してください。')
    }
    const thread = ops.getThread(this.deps.db, threadId)
    if (!thread) throw new ValidationError('スレッドが見つかりません。')
    const project = ops.getProject(this.deps.db, thread.project_id)!
    if (project.type !== 'chat') {
      throw new ValidationError('Cowork プロジェクトの実行には対応していません。')
    }
    if (this.running.has(threadId)) {
      throw new ValidationError('応答の生成中です。停止してから送信してください。')
    }
    // MDL-03: スレッド → プロジェクト → 全体の既定
    const model = resolveModel(
      this.deps.modelService.getDefaultModel(),
      project.model,
      thread.model
    )
    if (!model) {
      throw new ValidationError(
        'モデルが選択されていません。設定画面でモデル一覧を更新してください。'
      )
    }
    return { thread, project, model }
  }

  private checkNewContent(content: string, attachmentCount: number): void {
    if (content.trim() === '' && attachmentCount === 0) {
      throw new ValidationError('メッセージを入力してください。')
    }
    if (attachmentCount > ATTACHMENT_LIMITS.maxFiles) {
      throw new ValidationError(
        `添付できるファイルは 1 メッセージあたり ${ATTACHMENT_LIMITS.maxFiles} 個までです。`
      )
    }
  }

  private latestUserMessage(userMessageId: string): ops.MessageRecord {
    const target = ops.getMessage(this.deps.db, userMessageId)
    if (!target || target.role !== 'user') throw new ValidationError('メッセージが見つかりません。')
    const path = activePath(ops.listMessagesByThread(this.deps.db, target.thread_id))
    const latest = path.filter((m) => m.role === 'user').at(-1)
    if (latest?.id !== target.id) {
      throw new ValidationError('編集・再送信できるのは最新のメッセージだけです。')
    }
    return target
  }

  /**
   * ユーザーメッセージを作る。履歴と合わせた添付ファイルの合計が API の上限を超える場合は作らない
   */
  private createUserMessage(
    threadId: string,
    parentId: string | null,
    content: string,
    newAttachments: () => AttachmentInfo[]
  ): ops.MessageRecord {
    const added = newAttachments()
    const history = activePath(ops.listMessagesByThread(this.deps.db, threadId))
    const historyIds = new Set(history.map((m) => m.id))
    const historyBytes = ops
      .listAttachmentsByThread(this.deps.db, threadId)
      .filter((a) => historyIds.has(a.message_id))
      .reduce((sum, a) => sum + a.size_bytes, 0)
    const total = ((historyBytes + added.reduce((sum, a) => sum + a.size_bytes, 0)) * 4) / 3
    if (total > ATTACHMENT_LIMITS.maxRequestBytes) {
      throw new ValidationError(
        '会話内の添付ファイルの合計が API の上限（32MB）を超えるため送信できません。新しいスレッドで送信してください。'
      )
    }
    return ops.createMessage(this.deps.db, {
      thread_id: threadId,
      parent_id: parentId,
      role: 'user',
      content
    })
  }

  private setTitle(threadId: string, content: string): void {
    const firstLine = content.trim().split(/\r?\n/)[0] ?? ''
    if (firstLine === '') return
    const chars = [...firstLine]
    const title =
      chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH).join('')}…` : firstLine
    ops.updateThread(this.deps.db, threadId, { title })
  }

  // ========================================
  // 生成
  // ========================================

  private startGeneration(
    project: Project,
    threadId: string,
    userMessageId: string,
    model: string
  ): Message {
    const assistant = ops.createMessage(this.deps.db, {
      thread_id: threadId,
      parent_id: userMessageId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model
    })
    const controller = new AbortController()
    const entry = { controller, done: Promise.resolve() }
    entry.done = this.generate(project, threadId, assistant.id, model, controller.signal)
      .catch((error) => console.error('[chat] unexpected failure:', (error as Error).name))
      // 完了の通知の後に次の生成が始まっていれば、そちらは消さない
      .finally(() => {
        if (this.running.get(threadId) === entry) this.running.delete(threadId)
      })
    this.running.set(threadId, entry)
    return this.getPublic(assistant.id)
  }

  private buildMessages(threadId: string, assistantId: string): Anthropic.Beta.BetaMessageParam[] {
    const records = ops.listMessagesByThread(this.deps.db, threadId)
    const path = activePath(records).filter((m) => m.id !== assistantId)
    const attachments = new Map<string, ops.AttachmentRecord[]>()
    for (const a of ops.listAttachmentsByThread(this.deps.db, threadId)) {
      attachments.set(a.message_id, [...(attachments.get(a.message_id) ?? []), a])
    }

    const messages: Anthropic.Beta.BetaMessageParam[] = []
    for (const m of path) {
      if (m.role === 'user') {
        const blocks: Anthropic.Beta.BetaContentBlockParam[] = (attachments.get(m.id) ?? []).map(
          (a) => toContentBlock(a, this.deps.attachments.read(a))
        )
        if (m.content.trim() !== '') blocks.push({ type: 'text', text: m.content })
        messages.push({ role: 'user', content: blocks })
      } else if (m.status === 'complete' && m.content_blocks) {
        messages.push({
          role: 'assistant',
          content: JSON.parse(m.content_blocks) as Anthropic.Beta.BetaContentBlockParam[]
        })
      } else if (m.content.trim() !== '') {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] })
      }
    }
    return messages
  }

  private async generate(
    project: Project,
    threadId: string,
    assistantId: string,
    model: string,
    signal: AbortSignal
  ): Promise<void> {
    const { emit } = this.deps
    const info = this.deps.modelService.getModelInfo(model)
    const adaptive = info?.supports_adaptive_thinking ?? false
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: Math.min(DEFAULT_MAX_TOKENS, info?.max_tokens ?? DEFAULT_MAX_TOKENS),
      messages: this.buildMessages(threadId, assistantId),
      stream: true,
      // CHT-08: 長いカスタム指示や添付ファイルをキャッシュする
      cache_control: { type: 'ephemeral' },
      ...(project.custom_instructions ? { system: project.custom_instructions } : {}),
      ...(adaptive
        ? {
            thinking: {
              type: 'adaptive',
              display: 'summarized',
              block_binding: { prefix_mismatch_behavior: 'drop_block' }
            },
            betas: [THINKING_BETA]
          }
        : {})
    }

    const apiKey = this.deps.getApiKey()
    if (apiKey === null) return this.finish(assistantId, 'error', '', null, 'auth', null)
    // リトライは自前で行い、待機中であることを画面に表示する（6.14）
    const client = this.deps.createClient(apiKey, { maxRetries: 0 })

    let text = ''
    let thinking = ''
    let pending = { text: '', thinking: '' }
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    const flush = (): void => {
      if (pending.text) emit({ type: 'text', threadId, messageId: assistantId, text: pending.text })
      if (pending.thinking) {
        emit({ type: 'thinking', threadId, messageId: assistantId, text: pending.thinking })
      }
      pending = { text: '', thinking: '' }
    }
    const timer = setInterval(flush, this.deps.flushIntervalMs ?? 50)

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(params, { signal })
          for await (const event of stream) {
            if (event.type === 'message_start') {
              Object.assign(usage, pickUsage(event.message.usage))
            } else if (event.type === 'message_delta') {
              Object.assign(usage, pickUsage(event.usage))
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                text += event.delta.text
                pending.text += event.delta.text
              } else if (event.delta.type === 'thinking_delta') {
                thinking += event.delta.thinking
                pending.thinking += event.delta.thinking
              }
            }
          }
          const final = await stream.finalMessage()
          Object.assign(usage, pickUsage(final.usage))
          flush()
          const finalText = final.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('')
          return this.finish(
            assistantId,
            'complete',
            finalText,
            JSON.stringify(final.content),
            null,
            final.stop_reason,
            { project, threadId, model, usage }
          )
        } catch (error) {
          flush()
          if (signal.aborted) {
            return this.finish(assistantId, 'stopped', text, null, null, null, {
              project,
              threadId,
              model,
              usage
            })
          }
          const apiError = toApiRequestError(error, 'chat.stream')
          const nothingYet = text === '' && thinking === ''
          if (nothingYet && RETRYABLE.has(apiError.kind) && attempt < MAX_RETRIES) {
            const waitMs = Math.min(retryAfterMs(error) ?? 2000 * 2 ** attempt, MAX_WAIT_MS)
            emit({
              type: 'retrying',
              threadId,
              messageId: assistantId,
              attempt: attempt + 1,
              maxAttempts: MAX_RETRIES,
              waitMs,
              message: apiError.message
            })
            try {
              await this.sleep(waitMs, signal)
            } catch {
              return this.finish(assistantId, 'stopped', text, null, null, null)
            }
            continue
          }
          return this.finish(assistantId, 'error', text, null, apiError.kind, null, {
            project,
            threadId,
            model,
            usage
          })
        }
      }
    } finally {
      clearInterval(timer)
    }
  }

  private finish(
    assistantId: string,
    status: 'complete' | 'stopped' | 'error',
    content: string,
    contentBlocks: string | null,
    errorKind: ops.MessageRecord['error_kind'],
    stopReason: string | null,
    billing?: { project: Project; threadId: string; model: string; usage: TokenUsage }
  ): void {
    const { db } = this.deps
    let cost: number | null = null
    let tokens: number | null = null
    // 停止・エラーでも、API が受け付けた分は課金されるため記録する
    if (billing && billing.usage.input_tokens + billing.usage.output_tokens > 0) {
      const u = billing.usage
      cost = estimateCost(billing.model, u)
      tokens =
        u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      ops.insertUsageRecord(db, {
        project_id: billing.project.id,
        project_name: billing.project.name,
        thread_id: billing.threadId,
        message_id: assistantId,
        model: billing.model,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        cache_write_tokens: u.cache_creation_input_tokens,
        estimated_cost: cost ?? 0
      })
    }
    ops.updateMessage(db, assistantId, {
      status,
      content,
      content_blocks: contentBlocks,
      error_kind: errorKind,
      stop_reason: stopReason,
      tokens_used: tokens,
      estimated_cost: cost
    })
    const message = this.getPublic(assistantId)
    // 完了の通知を受けてすぐ次の操作ができるよう、通知より先に「生成中」を解除する
    this.running.delete(message.thread_id)
    const errorMessage = errorKind ? API_ERROR_MESSAGES[errorKind] : null
    this.deps.emit({ type: 'finished', threadId: message.thread_id, message, errorMessage })
  }

  // ========================================
  // 変換
  // ========================================

  private attachmentsByMessage(threadId: string): Map<string, ops.AttachmentRecord[]> {
    const map = new Map<string, ops.AttachmentRecord[]>()
    for (const a of ops.listAttachmentsByThread(this.deps.db, threadId)) {
      map.set(a.message_id, [...(map.get(a.message_id) ?? []), a])
    }
    return map
  }

  private getPublic(messageId: string): Message {
    const record = ops.getMessage(this.deps.db, messageId)!
    const attachments = this.attachmentsByMessage(record.thread_id).get(record.id) ?? []
    return this.toPublic(record, attachments)
  }

  private toPublic(record: ops.MessageRecord, attachments: ops.AttachmentRecord[]): Message {
    const { content_blocks: _blocks, agent_resume_uuid: _resume, ...rest } = record
    void _blocks
    void _resume
    return { ...rest, thinking: thinkingOf(record), attachments: attachments.map(toInfo) }
  }
}

function pickUsage(
  u: Partial<Record<keyof TokenUsage, number | null>> | null | undefined
): Partial<TokenUsage> {
  const result: Partial<TokenUsage> = {}
  if (!u) return result
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens'
  ] as const) {
    const value = u[key]
    if (typeof value === 'number') result[key] = value
  }
  return result
}
