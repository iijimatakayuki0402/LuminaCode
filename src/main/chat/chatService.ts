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
import { activePath, pathTo } from '@shared/conversation'
import { resolveModel } from '@shared/models'
import type {
  AttachmentInfo,
  ChatEvent,
  EditAndResendInput,
  Message,
  WebSource,
  Project,
  SendMessageInput,
  SendResult,
  Thread
} from '@shared/types'
import type { ClientFactory } from '../api/client'
import { API_ERROR_MESSAGES, toApiRequestError } from '../api/errors'
import * as ops from '../db/operations'
import type { ModelService } from '../models/modelService'
import { combineInstructions } from '../settings/instructions'
import type { TitleGenerator } from './titleGenerator'
import type { UsageService } from '../usage/usageService'
import { ATTACHMENT_LIMITS, kindOfMime, toContentBlock, type AttachmentStore } from './attachments'
import { estimateCost, type TokenUsage } from './pricing'
import {
  isThinkingConfigError,
  offCandidates,
  rememberOffMode,
  THINKING_BETA,
  thinkingParams,
  type ThinkingMode
} from './thinking'

const { ValidationError } = ops

/** 最大のリトライ回数（6.14） */
export const MAX_RETRIES = 3
const RETRYABLE = new Set(['rate_limit', 'overloaded', 'server', 'timeout'])
const MAX_WAIT_MS = 60_000
const DEFAULT_MAX_TOKENS = 64_000
/** CHT-11: 1 回の応答で行う Web 検索の上限と、pause_turn で続きを頼む回数の上限 */
const WEB_SEARCH_MAX_USES = 5
const MAX_CONTINUATIONS = 5
const SERVER_TOOL_BLOCKS = new Set(['server_tool_use', 'web_search_tool_result'])
const TITLE_LENGTH = 40

export interface ChatServiceDeps {
  db: Database.Database
  /** CHT-11: プロジェクトで Web 検索をオンにしているか */
  isWebSearchEnabled?: (projectId: string) => boolean
  attachments: AttachmentStore
  modelService: ModelService
  getApiKey: () => string | null
  createClient: ClientFactory
  emit: (event: ChatEvent) => void
  /** 全プロジェクト共通のカスタム指示（PRJ-08） */
  getGlobalInstructions?: () => string
  /** タイトルの自動生成（THR-03） */
  titles?: Pick<TitleGenerator, 'generate'>
  /** 上限の確認と概算コスト（USG）。省略時は既定の単価表で計算し、上限は確認しない */
  usage?: Pick<UsageService, 'check' | 'estimate'>
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

  /** 表示中の分岐（CHT-06） */
  private path(threadId: string): ops.MessageRecord[] {
    const thread = ops.getThread(this.deps.db, threadId)
    return activePath(ops.listMessagesByThread(this.deps.db, threadId), thread?.active_leaf_id)
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
    const parent = this.path(thread.id).at(-1) ?? null

    const userMessage = this.createUserMessage(thread.id, parent?.id ?? null, input.content, () =>
      this.deps.attachments.getStaged(input.attachmentIds)
    )
    const committed = this.deps.attachments.commit(userMessage.id, input.attachmentIds)
    for (const record of committed) ops.insertAttachment(this.deps.db, record)

    if (thread.title === null) this.setTitle(thread.id, input.content)
    const assistantMessage = this.startGeneration(project, thread.id, userMessage.id, model)
    return { userMessage: this.getPublic(userMessage.id), assistantMessage }
  }

  /** ユーザーメッセージに対する応答を作り直す（停止・エラー後の再試行、CHT-06 の再生成） */
  regenerate(userMessageId: string): Message {
    const user = this.userMessageInPath(userMessageId)
    const { project, model } = this.prepare(user.thread_id)
    return this.startGeneration(project, user.thread_id, user.id, model)
  }

  /**
   * ユーザーメッセージを編集して再送信する（CHT-14。CHT-06 により最新以外も編集できる）
   * 元のメッセージと応答は分岐履歴として残し、同じ親の下に新しいメッセージを作る。
   */
  editAndResend(input: EditAndResendInput): SendResult {
    const original = this.userMessageInPath(input.userMessageId)
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
    // USG-04: 上限に達していれば停止する
    this.deps.usage?.check(project.id)
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

  /** 表示中の分岐にあるユーザーメッセージ（CHT-06: 最新以外も編集・再生成できる） */
  private userMessageInPath(userMessageId: string): ops.MessageRecord {
    const target = ops.getMessage(this.deps.db, userMessageId)
    if (!target || target.role !== 'user') throw new ValidationError('メッセージが見つかりません。')
    if (!this.path(target.thread_id).some((m) => m.id === target.id)) {
      throw new ValidationError('表示中の会話にないメッセージは編集・再送信できません。')
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
    // 送信先の分岐（親までの一続き）
    const history = parentId
      ? pathTo(ops.listMessagesByThread(this.deps.db, threadId), parentId)
      : []
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
    ops.updateThread(this.deps.db, threadId, { title, title_source: 'auto' })
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
    // CHT-06: 新しい応答を表示中の分岐にする
    ops.updateThread(this.deps.db, threadId, { active_leaf_id: assistant.id })
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

  private buildMessages(
    threadId: string,
    assistantId: string,
    thinking: boolean,
    webSearch: boolean
  ): Anthropic.Beta.BetaMessageParam[] {
    const path = this.path(threadId).filter((m) => m.id !== assistantId)
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
        const blocks = JSON.parse(m.content_blocks) as Anthropic.Beta.BetaContentBlockParam[]
        // CHT-11: Web 検索をオフにした後は、検索を含む回答を本文だけにして送る（ツールの定義が無いため）
        if (!webSearch && blocks.some((b) => SERVER_TOOL_BLOCKS.has(b.type))) {
          messages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] })
          continue
        }
        messages.push({
          role: 'assistant',
          // CHT-07: 思考をオフにした場合は、以前の思考ブロックを送り返さない
          content: thinking
            ? blocks
            : blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
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
    const thread = ops.getThread(this.deps.db, threadId)
    // CHT-07: 思考量（モデルが対応している場合のみ指定する）
    const effort =
      thread?.effort && info?.effort_levels.includes(thread.effort) ? thread.effort : null
    // CHT-07: 拡張思考。オフにしたスレッドでは、モデルが受け付ける「止める指定」を順に試す（thinking.ts）
    const supportsThinking = info?.supports_adaptive_thinking ?? false
    const wantsOff = supportsThinking && thread?.extended_thinking === false
    const offModes = wantsOff ? offCandidates(this.deps.db, model, effort) : []
    let mode: ThinkingMode = !supportsThinking ? 'none' : (offModes[0] ?? 'on')
    // CHT-11: Web 検索（プロジェクトでオンにした場合のみ。新しいモデルは結果の絞り込みに対応した版を使う）
    const webSearch = this.deps.isWebSearchEnabled?.(project.id) ?? false
    const webTool: Anthropic.Beta.BetaToolUnion = supportsThinking
      ? { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }
      : { type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }
    // pause_turn（サーバー側のツール実行が途中で区切られた）で続きを頼むときの、それまでの応答
    let paused: Anthropic.Beta.BetaContentBlock[] = []
    // PRJ-08: グローバル → プロジェクトの順に結合する。CTX-02 の要約も加える
    const system = combineInstructions(
      this.deps.getGlobalInstructions?.() ?? '',
      project.custom_instructions,
      thread?.context_summary
    )
    const buildParams = (): Anthropic.Beta.MessageCreateParamsStreaming => ({
      model,
      max_tokens: Math.min(DEFAULT_MAX_TOKENS, info?.max_tokens ?? DEFAULT_MAX_TOKENS),
      // 思考を止める場合は、以前の思考ブロックを送り返さない
      messages: [
        ...this.buildMessages(threadId, assistantId, mode === 'on', webSearch),
        ...(paused.length > 0
          ? [
              {
                role: 'assistant' as const,
                content: paused as Anthropic.Beta.BetaContentBlockParam[]
              }
            ]
          : [])
      ],
      ...(webSearch ? { tools: [webTool] } : {}),
      stream: true,
      // CHT-08: 長いカスタム指示や添付ファイルをキャッシュする
      cache_control: { type: 'ephemeral' },
      ...(system ? { system } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...thinkingParams(mode)
    })
    let params = buildParams()

    const apiKey = this.deps.getApiKey()
    if (apiKey === null) return this.finish(assistantId, 'error', '', null, 'auth', null)
    // リトライは自前で行い、待機中であることを画面に表示する（6.14）
    const client = this.deps.createClient(apiKey, { maxRetries: 0 })

    let text = ''
    let thinking = ''
    let pending = { text: '', thinking: '' }
    const zero = (): TokenUsage => ({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      web_search_requests: 0
    })
    const usage = zero()
    // pause_turn で続けた場合は、前の応答までの使用量を足す
    const carried = zero()
    const total = (): TokenUsage => ({
      input_tokens: carried.input_tokens + usage.input_tokens,
      output_tokens: carried.output_tokens + usage.output_tokens,
      cache_creation_input_tokens:
        carried.cache_creation_input_tokens + usage.cache_creation_input_tokens,
      cache_read_input_tokens: carried.cache_read_input_tokens + usage.cache_read_input_tokens,
      web_search_requests: (carried.web_search_requests ?? 0) + (usage.web_search_requests ?? 0)
    })
    const flush = (): void => {
      if (pending.text) emit({ type: 'text', threadId, messageId: assistantId, text: pending.text })
      if (pending.thinking) {
        emit({ type: 'thinking', threadId, messageId: assistantId, text: pending.thinking })
      }
      pending = { text: '', thinking: '' }
    }
    const timer = setInterval(flush, this.deps.flushIntervalMs ?? 50)

    let continuations = 0
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(params, { signal })
          let searchInput: string | null = null
          for await (const event of stream) {
            if (event.type === 'message_start') {
              Object.assign(usage, pickUsage(event.message.usage))
            } else if (event.type === 'message_delta') {
              Object.assign(usage, pickUsage(event.usage))
            } else if (
              event.type === 'content_block_start' &&
              event.content_block.type === 'server_tool_use'
            ) {
              searchInput = ''
            } else if (event.type === 'content_block_stop' && searchInput !== null) {
              // CHT-11: 検索している語を画面に出す
              emit({
                type: 'webSearch',
                threadId,
                messageId: assistantId,
                query: queryOf(searchInput)
              })
              searchInput = null
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'input_json_delta' && searchInput !== null) {
                searchInput += event.delta.partial_json
              } else if (event.delta.type === 'text_delta') {
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
          if (mode === 'disabled' || mode === 'between_tools') {
            rememberOffMode(this.deps.db, model, mode)
          }
          // CHT-11: サーバー側の検索が区切られたら、それまでの応答を付けて続きを頼む（回数に上限を設ける）
          if (final.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
            continuations++
            paused = [...paused, ...final.content]
            Object.assign(carried, total())
            Object.assign(usage, zero())
            params = buildParams()
            attempt = -1
            continue
          }
          const content = [...paused, ...final.content]
          const finalText = content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('')
          return this.finish(
            assistantId,
            'complete',
            finalText,
            JSON.stringify(content),
            null,
            final.stop_reason,
            { project, threadId, model, usage: total() }
          )
        } catch (error) {
          flush()
          if (signal.aborted) {
            return this.finish(assistantId, 'stopped', text, null, null, null, {
              project,
              threadId,
              model,
              usage: total()
            })
          }
          const nothingYet = text === '' && thinking === ''
          // CHT-07: 思考を止める指定を受け付けないモデルなら、次の指定を試す（どれも駄目ならオンのまま送る）
          if (nothingYet && offModes.length > 0 && isThinkingConfigError(error)) {
            offModes.shift()
            const next = offModes[0]
            if (!next && effort !== 'xhigh' && effort !== 'max') {
              rememberOffMode(this.deps.db, model, 'unsupported')
            }
            console.warn(
              `[chat] thinking mode ${mode} rejected for ${model}; trying ${next ?? 'on'}`
            )
            mode = next ?? 'on'
            params = buildParams()
            attempt--
            continue
          }
          const apiError = toApiRequestError(error, 'chat.stream')
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
            usage: total()
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
      cost = this.deps.usage
        ? this.deps.usage.estimate(billing.model, u)
        : estimateCost(billing.model, u)
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
    // 10.2: API 呼び出しの成否を記録する（本文は含めない）
    console.info(
      `[chat] request ${status}: model=${billing?.model ?? '-'} tokens=${tokens ?? 0}${errorKind ? ` error=${errorKind}` : ''}${stopReason ? ` stop=${stopReason}` : ''}`
    )
    const message = this.getPublic(assistantId)
    // 完了の通知を受けてすぐ次の操作ができるよう、通知より先に「生成中」を解除する
    this.running.delete(message.thread_id)
    const errorMessage = errorKind ? API_ERROR_MESSAGES[errorKind] : null
    this.deps.emit({ type: 'finished', threadId: message.thread_id, message, errorMessage })

    // THR-03: 最初のやり取りが完了したらタイトルを作る（失敗しても会話には影響させない）
    if (status === 'complete' && this.deps.titles) {
      const thread = ops.getThread(db, message.thread_id)
      const path = this.path(message.thread_id)
      if (thread?.title_source === 'auto' && path.length === 2 && path[0].role === 'user') {
        void this.deps.titles.generate(thread.id, path[0].content, content, message.model ?? '')
      }
    }
  }

  // ========================================
  // コンテキスト管理（CTX-02）
  // ========================================

  /**
   * これまでの会話を要約し、要約を引き継いだ新しいスレッドを作る
   * 過去の思考ブロックは持ち越さない（要約だけで続ける単純な圧縮。履歴の書き換えによる不整合を避ける）
   */
  async compact(threadId: string): Promise<Thread> {
    const { thread, project, model } = this.prepare(threadId)
    const path = this.path(threadId)
    if (path.filter((m) => m.role === 'assistant' && m.status === 'complete').length === 0) {
      throw new ValidationError('要約できる会話がありません。')
    }
    const apiKey = this.deps.getApiKey()!
    const client = this.deps.createClient(apiKey)
    const info = this.deps.modelService.getModelInfo(model)
    // 要約は質を優先し、対応するモデルでは常に思考をオンにする（スレッドの設定にかかわらない）
    const thinking = info?.supports_adaptive_thinking ?? false
    // 要約にはツールを渡さないため、検索を含む回答は本文だけにする
    const messages = this.buildMessages(threadId, '', thinking, false)
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'ここまでの会話を、新しいスレッドで続けるための要約にしてください。決定事項、前提条件、作業中の内容、未解決の課題、ユーザーの好みなど、続きの会話に必要な情報は省かずに含めてください。要約だけを出力してください。'
        }
      ]
    })
    const system = combineInstructions(
      this.deps.getGlobalInstructions?.() ?? '',
      project.custom_instructions,
      thread.context_summary
    )
    let final: Anthropic.Beta.BetaMessage
    try {
      final = await client.beta.messages
        .stream({
          model,
          max_tokens: Math.min(16_000, info?.max_tokens ?? 16_000),
          messages,
          ...(system ? { system } : {}),
          ...(thinking
            ? {
                thinking: {
                  type: 'adaptive' as const,
                  block_binding: { prefix_mismatch_behavior: 'drop_block' as const }
                },
                betas: [THINKING_BETA]
              }
            : {})
        })
        .finalMessage()
    } catch (error) {
      throw toApiRequestError(error, 'chat.compact')
    }
    const summary = final.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim()
    if (!summary) throw new ValidationError('要約を作成できませんでした。')

    const usage = {
      input_tokens: final.usage.input_tokens,
      output_tokens: final.usage.output_tokens,
      cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0
    }
    ops.insertUsageRecord(this.deps.db, {
      project_id: project.id,
      project_name: project.name,
      thread_id: threadId,
      message_id: null,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens,
      cache_write_tokens: usage.cache_creation_input_tokens,
      estimated_cost:
        (this.deps.usage ? this.deps.usage.estimate(model, usage) : estimateCost(model, usage)) ?? 0
    })

    const next = ops.createThread(this.deps.db, {
      project_id: project.id,
      title: `${thread.title ?? '無題のスレッド'}（続き）`,
      ...(thread.model ? { model: thread.model } : {})
    })
    return ops.updateThread(this.deps.db, next.id, {
      context_summary: summary,
      effort: thread.effort,
      title_source: 'manual'
    })!
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
    const {
      content_blocks: _blocks,
      agent_resume_uuid: _resume,
      agent_usage_total: _total,
      ...rest
    } = record
    void _blocks
    void _resume
    void _total
    return {
      ...rest,
      thinking: thinkingOf(record),
      sources: sourcesOf(record),
      attachments: attachments.map(toInfo)
    }
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
  const searches = (u as { server_tool_use?: { web_search_requests?: number | null } | null })
    .server_tool_use?.web_search_requests
  if (typeof searches === 'number') result.web_search_requests = searches
  return result
}

/** server_tool_use の入力（JSON）から検索語を取り出す */
function queryOf(input: string): string {
  try {
    const query = (JSON.parse(input) as { query?: unknown }).query
    return typeof query === 'string' ? query : ''
  } catch {
    return ''
  }
}

/** 回答の引用元（CHT-11）。web_search_result_location の引用を URL ごとにまとめる */
function sourcesOf(record: ops.MessageRecord): WebSource[] {
  if (!record.content_blocks) return []
  const seen = new Map<string, WebSource>()
  try {
    for (const block of JSON.parse(record.content_blocks) as {
      type: string
      citations?: { type: string; url?: string; title?: string | null }[] | null
    }[]) {
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location' && c.url && !seen.has(c.url)) {
          seen.set(c.url, { url: c.url, title: c.title ?? null })
        }
      }
    }
  } catch {
    return []
  }
  return [...seen.values()]
}
