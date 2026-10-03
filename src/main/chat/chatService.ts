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
import { estimateCost, WEB_SEARCH_USD, type ModelPrice, type TokenUsage } from './pricing'
import {
  isThinkingConfigError,
  offCandidates,
  rememberOffMode,
  THINKING_BETA,
  thinkingParams,
  type ThinkingMode
} from './thinking'
import {
  echoBlocks,
  FALLBACK_BETA,
  fallbackOf,
  isFallbackConfigError,
  rememberFallbackUnsupported,
  splitUsage,
  supportsFallback,
  type ModelUsage
} from './fallback'

const { ValidationError } = ops

/** 最大のリトライ回数（6.14） */
export const MAX_RETRIES = 3
const RETRYABLE = new Set(['rate_limit', 'overloaded', 'server', 'timeout'])
const MAX_WAIT_MS = 60_000
const DEFAULT_MAX_TOKENS = 64_000
/** CHT-11: 1 回の応答で行う Web 検索の上限と、pause_turn で続きを頼む回数の上限 */
const WEB_SEARCH_MAX_USES = 5
const MAX_CONTINUATIONS = 5
const SEARCH_OMITTED_NOTE =
  '（この回答は Web 検索の結果をもとにしています。検索結果そのものは省略しています。）'
/** 引用が無い場合に示す検索結果の上限 */
const MAX_SEARCH_RESULTS = 10
/** サーバー側のツール（Web 検索と、結果の絞り込みに使うコード実行）のブロック */
const SERVER_TOOL_BLOCKS = new Set([
  'server_tool_use',
  'web_search_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result'
])
const TITLE_LENGTH = 40
/** USG-04: 残りの予算で出せる出力がこれより少なければ送信しない */
export const MIN_BUDGET_OUTPUT = 1024
/** USG-04: 画像 1 枚の入力トークンの見込み（実際は大きさによる。多めに見積もる） */
const IMAGE_TOKENS = 5000

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
  /** CHT-16: 拒否されたときに別のモデルで回答し直すか（省略時はオン） */
  isFallbackEnabled?: () => boolean
  /** 上限の確認と概算コスト（USG）。省略時は既定の単価表で計算し、上限は確認しない */
  usage?: Pick<UsageService, 'check' | 'estimate' | 'priceOf' | 'contextOf'>
  /** テストで待ち時間を短縮するために差し替える */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  flushIntervalMs?: number
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
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
  let blocks: ContentBlock[]
  try {
    blocks = JSON.parse(record.content_blocks) as ContentBlock[]
  } catch {
    return null
  }
  if (!Array.isArray(blocks)) return null
  const text = blocks
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
    const { thread, project, model, remainingUsd } = this.prepare(input.threadId)
    this.checkNewContent(input.content, input.attachmentIds.length)
    const parent = this.path(thread.id).at(-1) ?? null

    const userMessage = this.createUserMessage(thread.id, parent?.id ?? null, input.content, () =>
      this.deps.attachments.getStaged(input.attachmentIds)
    )
    const committed = this.deps.attachments.commit(userMessage.id, input.attachmentIds)
    for (const record of committed) ops.insertAttachment(this.deps.db, record)

    if (thread.title === null) this.setTitle(thread.id, input.content)
    const assistantMessage = this.startGeneration(
      project,
      thread.id,
      userMessage.id,
      model,
      remainingUsd
    )
    return { userMessage: this.getPublic(userMessage.id), assistantMessage }
  }

  /** ユーザーメッセージに対する応答を作り直す（停止・エラー後の再試行、CHT-06 の再生成） */
  regenerate(userMessageId: string): Message {
    const user = this.userMessageInPath(userMessageId)
    const { project, model, remainingUsd } = this.prepare(user.thread_id)
    return this.startGeneration(project, user.thread_id, user.id, model, remainingUsd)
  }

  /**
   * ユーザーメッセージを編集して再送信する（CHT-14。CHT-06 により最新以外も編集できる）
   * 元のメッセージと応答は分岐履歴として残し、同じ親の下に新しいメッセージを作る。
   */
  editAndResend(input: EditAndResendInput): SendResult {
    const original = this.userMessageInPath(input.userMessageId)
    const { project, model, remainingUsd } = this.prepare(original.thread_id)
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
      model,
      remainingUsd
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

  private prepare(threadId: string): {
    thread: Thread
    project: Project
    model: string
    /** USG-04: 上限までの残り（USD）。上限が無い・警告のみなら null */
    remainingUsd: number | null
  } {
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
    const remainingUsd = this.deps.usage?.check(project.id).remainingUsd ?? null
    return { thread, project, model, remainingUsd }
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
    model: string,
    remainingUsd: number | null
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
    entry.done = this.generate(
      project,
      threadId,
      assistant.id,
      model,
      remainingUsd,
      controller.signal
    )
      .catch((error) => {
        console.error('[chat] unexpected failure:', (error as Error).name)
        // 生成中のまま残らないよう、エラーとして閉じる
        try {
          if (ops.getMessage(this.deps.db, assistant.id)?.status === 'streaming') {
            this.finish(assistant.id, 'error', '', null, 'unknown', null, null)
          }
        } catch (inner) {
          console.error('[chat] failed to close the reply:', (inner as Error).name)
        }
      })
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
    /** 検索のブロックを残すか（false は本文だけにする。ツールを渡さない要約で使う） */
    keepServerTools: boolean
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
        // CHT-16: フォールバックした回答は、送り返せる形に整える（fallback.ts）
        const blocks = echoBlocks(
          JSON.parse(m.content_blocks) as Anthropic.Beta.BetaContentBlockParam[]
        )
        // CHT-11: ツールを渡さないリクエストでは、検索を含む回答を本文だけにして送る
        if (!keepServerTools && blocks.some((b) => SERVER_TOOL_BLOCKS.has(b.type))) {
          // 検索結果が無いと「調べていない」と誤解されるため、もとにしたことを書き添える
          const text = [m.content, SEARCH_OMITTED_NOTE].join('\n\n')
          messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
          continue
        }
        // CHT-07: 思考をオフにした場合は、以前の思考ブロックを送り返さない
        const content = thinking
          ? blocks
          : blocks.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
        // 空の応答は API が受け付けないため送らない（本文があれば本文だけ送る）
        if (content.length > 0) messages.push({ role: 'assistant', content })
        else if (m.content.trim() !== '')
          messages.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] })
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
    remainingUsd: number | null,
    stopSignal: AbortSignal
  ): Promise<void> {
    const { emit, db } = this.deps
    const info = this.deps.modelService.getModelInfo(model)
    const thread = ops.getThread(db, threadId)
    // CHT-07: 思考量（モデルが対応している場合のみ指定する）
    const effort =
      thread?.effort && info?.effort_levels.includes(thread.effort) ? thread.effort : null
    // CHT-07: 拡張思考。オフにしたスレッドでは、モデルが受け付ける「止める指定」を順に試す（thinking.ts）
    const supportsThinking = info?.supports_adaptive_thinking ?? false
    const wantsOff = supportsThinking && thread?.extended_thinking === false
    const offModes = wantsOff ? offCandidates(db, model, effort) : []
    let mode: ThinkingMode = !supportsThinking ? 'none' : (offModes[0] ?? 'on')
    // CHT-16: 拒否されたら別のモデルで回答し直す（受け付けないモデルには指定しない。fallback.ts）
    let useFallback = (this.deps.isFallbackEnabled?.() ?? true) && supportsFallback(db, model)
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

    // USG-04: 生成中に上限を超えたら中断する（停止ボタンによる停止と区別するため、別の信号で止める）
    const controller = new AbortController()
    const signal = controller.signal
    const relayStop = (): void => controller.abort()
    if (stopSignal.aborted) relayStop()
    else stopSignal.addEventListener('abort', relayStop, { once: true })
    let budgetHit = false
    /** 確定した使用量（pause_turn で続ける前の応答と、フォールバックの各試行） */
    const billed: ModelUsage[] = []
    const billedCost = (): number =>
      billed.reduce((sum, e) => sum + (this.estimate(e.model, e.usage) ?? 0), 0)
    const modelMax = Math.min(DEFAULT_MAX_TOKENS, info?.max_tokens ?? DEFAULT_MAX_TOKENS)
    /** USG-04: 残りの予算から決めた出力の上限（null は絞らない） */
    let budgetCap: number | null = null

    const buildParams = (): Anthropic.Beta.MessageCreateParamsStreaming => {
      // 思考を止める場合は、以前の思考ブロックを送り返さない
      const history = this.buildMessages(threadId, assistantId, mode === 'on', true)
      // CHT-11: 検索をオフにした後も、以前の検索結果は残して送る（本文だけにすると「調べていない」と誤解される）。
      // その場合は検索ツールを定義したうえで、使わせない（tool_choice: none）
      const searchedBefore = history.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => SERVER_TOOL_BLOCKS.has((b as { type: string }).type))
      )
      budgetCap = this.outputCap(
        model,
        remainingUsd,
        billedCost(),
        threadId,
        history,
        system,
        paused
      )
      return buildRequest(history, searchedBefore)
    }
    const buildRequest = (
      history: Anthropic.Beta.BetaMessageParam[],
      searchedBefore: boolean
    ): Anthropic.Beta.MessageCreateParamsStreaming => {
      const thinkingPart = thinkingParams(mode)
      const betas = [...(thinkingPart.betas ?? []), ...(useFallback ? [FALLBACK_BETA] : [])]
      return {
        model,
        max_tokens: budgetCap !== null ? Math.min(modelMax, budgetCap) : modelMax,
        messages: [
          ...history,
          ...(paused.length > 0
            ? [
                {
                  role: 'assistant' as const,
                  content: paused as Anthropic.Beta.BetaContentBlockParam[]
                }
              ]
            : [])
        ],
        ...(webSearch || searchedBefore ? { tools: [webTool] } : {}),
        ...(!webSearch && searchedBefore ? { tool_choice: { type: 'none' as const } } : {}),
        stream: true,
        // CHT-08: 長いカスタム指示や添付ファイルをキャッシュする
        cache_control: { type: 'ephemeral' },
        ...(system ? { system } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        ...thinkingPart,
        ...(useFallback ? { fallbacks: 'default' as const } : {}),
        ...(betas.length > 0 ? { betas } : {})
      }
    }
    let params = buildParams()

    const apiKey = this.deps.getApiKey()
    if (apiKey === null) return this.finish(assistantId, 'error', '', null, 'auth', null, null)
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
    /** 受信中の応答の使用量（開始時に分かる入力など） */
    const usage = zero()
    /** 受信中の応答を作っているモデル（CHT-16: 拒否されて切り替わると変わる） */
    let servedModel = model
    const priceFor = (m: string): ModelPrice | null =>
      remainingUsd !== null ? (this.deps.usage?.priceOf(m) ?? null) : null
    let servedPrice = priceFor(model)
    /** 受信中の応答の Web 検索の回数と、受け取った文字数（USG-04 の概算に使う） */
    let searches = 0
    let streamedChars = 0
    /** 受信中の応答より前に確定した分の概算コスト（受信中は変わらないため、受信の開始時に求める） */
    let spentBefore = 0
    // 出力トークン数は応答の最後まで分からないため、文字数から少なめに見積もる（4 文字で 1 トークン）
    const outputEstimate = (): number => Math.ceil(streamedChars / 4)
    const checkBudget = (): void => {
      if (remainingUsd === null || budgetHit || !servedPrice) return
      const p = servedPrice
      const spent =
        spentBefore +
        (usage.input_tokens * p.input +
          usage.cache_creation_input_tokens * p.cacheWrite +
          usage.cache_read_input_tokens * p.cacheRead +
          Math.max(usage.output_tokens, outputEstimate()) * p.output) /
          1_000_000 +
        searches * WEB_SEARCH_USD
      if (spent >= remainingUsd) {
        budgetHit = true
        console.info('[chat] stopping: usage limit reached during generation')
        controller.abort()
      }
    }
    /** 中断・エラーの時点までの使用量 */
    const partial = (): ModelUsage[] => [
      ...billed,
      {
        model: servedModel,
        usage: {
          ...usage,
          // 上限で止めた場合は、受け取った分の出力と検索も数える（応答の最後の使用量が届かないため）
          ...(budgetHit
            ? {
                output_tokens: Math.max(usage.output_tokens, outputEstimate()),
                web_search_requests: Math.max(usage.web_search_requests ?? 0, searches)
              }
            : {})
        }
      }
    ]
    const flush = (): void => {
      if (pending.text) emit({ type: 'text', threadId, messageId: assistantId, text: pending.text })
      if (pending.thinking) {
        emit({ type: 'thinking', threadId, messageId: assistantId, text: pending.thinking })
      }
      pending = { text: '', thinking: '' }
    }
    const timer = setInterval(flush, this.deps.flushIntervalMs ?? 50)

    let continuations = 0
    let completed: { text: string; blocks: string; stopReason: string | null } | null = null
    try {
      for (let attempt = 0; ; attempt++) {
        // USG-04: 残りの予算で十分な出力ができない場合は送らない
        if (budgetCap !== null && budgetCap < MIN_BUDGET_OUTPUT) {
          console.info('[chat] not sent: remaining budget is too small')
          const started = text !== '' || paused.length > 0
          return this.finish(
            assistantId,
            started ? 'stopped' : 'error',
            text,
            null,
            'budget',
            null,
            { project, threadId, entries: billed },
            servedModel
          )
        }
        try {
          const stream = client.beta.messages.stream(params, { signal })
          let searchInput: string | null = null
          searches = 0
          streamedChars = 0
          spentBefore = remainingUsd !== null ? billedCost() : 0
          for await (const event of stream) {
            if (event.type === 'message_start') {
              Object.assign(usage, pickUsage(event.message.usage))
              // CHT-16: 送信前に切り替わった場合は、開始の時点で回答するモデルが分かる
              if (event.message.model && event.message.model !== servedModel) {
                servedModel = event.message.model
                servedPrice = priceFor(servedModel)
              }
              checkBudget()
            } else if (event.type === 'message_delta') {
              Object.assign(usage, pickUsage(event.usage))
            } else if (
              event.type === 'content_block_start' &&
              event.content_block.type === 'fallback'
            ) {
              // CHT-16: 拒否されて別のモデルに切り替わった
              const { from, to } = event.content_block
              emit({
                type: 'fallback',
                threadId,
                messageId: assistantId,
                from: from.model,
                to: to.model
              })
              servedModel = to.model
              servedPrice = priceFor(servedModel)
            } else if (
              event.type === 'content_block_start' &&
              event.content_block.type === 'server_tool_use' &&
              event.content_block.name === 'web_search'
            ) {
              searches++
              checkBudget()
              // 結果を絞り込む版では、コード実行から呼ばれた検索の語が最初から入っている
              const query = (event.content_block.input as { query?: unknown } | null)?.query
              if (typeof query === 'string' && query !== '') {
                emit({ type: 'webSearch', threadId, messageId: assistantId, query })
              } else {
                searchInput = ''
              }
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
                streamedChars += event.delta.text.length
                checkBudget()
              } else if (event.delta.type === 'thinking_delta') {
                thinking += event.delta.thinking
                pending.thinking += event.delta.thinking
                streamedChars += event.delta.thinking.length
                checkBudget()
              }
            }
          }
          const final = await stream.finalMessage()
          flush()
          if (mode === 'disabled' || mode === 'between_tools') {
            rememberOffMode(db, model, mode)
          }
          // CHT-16: フォールバックした場合は、試行ごとの使用量をモデルごとに分けて記録する
          billed.push(...splitUsage(final, model))
          if (final.model) servedModel = final.model
          Object.assign(usage, zero())
          // CHT-11: サーバー側の検索が区切られたら、それまでの応答を付けて続きを頼む（回数に上限を設ける）
          if (final.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
            continuations++
            paused = [...paused, ...final.content]
            params = buildParams()
            attempt = -1
            continue
          }
          const content = [...paused, ...final.content]
          const finalText = content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('')
          // 完了の保存は try の外で行う（保存の失敗を API のエラーとして扱わないように）
          completed = {
            text: finalText,
            blocks: JSON.stringify(content),
            stopReason: final.stop_reason
          }
          break
        } catch (error) {
          flush()
          if (signal.aborted) {
            return this.finish(
              assistantId,
              'stopped',
              text,
              null,
              budgetHit ? 'budget' : null,
              null,
              { project, threadId, entries: partial() },
              servedModel
            )
          }
          const nothingYet = text === '' && thinking === ''
          // CHT-16: fallbacks を受け付けないモデルなら、指定せずに送り直し、次からは指定しない
          if (nothingYet && useFallback && isFallbackConfigError(error)) {
            rememberFallbackUnsupported(db, model)
            console.warn(`[chat] fallbacks rejected for ${model}; sending without them`)
            useFallback = false
            params = buildParams()
            attempt--
            continue
          }
          // CHT-07: 思考を止める指定を受け付けないモデルなら、次の指定を試す（どれも駄目ならオンのまま送る）
          if (nothingYet && offModes.length > 0 && isThinkingConfigError(error)) {
            offModes.shift()
            const next = offModes[0]
            if (!next && effort !== 'xhigh' && effort !== 'max') {
              rememberOffMode(db, model, 'unsupported')
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
              return this.finish(assistantId, 'stopped', text, null, null, null, null)
            }
            continue
          }
          return this.finish(
            assistantId,
            'error',
            text,
            null,
            apiError.kind,
            null,
            { project, threadId, entries: partial() },
            servedModel
          )
        }
      }
      const billing = { project, threadId, entries: billed }
      // USG-04: 予算で絞った出力の上限で止まった場合は、上限に達したため中断したものとして扱う
      if (completed.stopReason === 'max_tokens' && budgetCap !== null && budgetCap < modelMax) {
        return this.finish(
          assistantId,
          'stopped',
          completed.text,
          null,
          'budget',
          'max_tokens',
          billing,
          servedModel
        )
      }
      return this.finish(
        assistantId,
        'complete',
        completed.text,
        completed.blocks,
        null,
        completed.stopReason,
        billing,
        servedModel
      )
    } finally {
      clearInterval(timer)
      stopSignal.removeEventListener('abort', relayStop)
    }
  }

  private estimate(model: string, usage: TokenUsage): number | null {
    return this.deps.usage ? this.deps.usage.estimate(model, usage) : estimateCost(model, usage)
  }

  /**
   * USG-04: 残りの予算から決める出力の上限（トークン）。上限が無い・単価が不明なら null
   * 入力は送る前には正確に分からないため、直前のリクエストの実測値などから多めに見積もる
   */
  private outputCap(
    model: string,
    remainingUsd: number | null,
    spentUsd: number,
    threadId: string,
    history: Anthropic.Beta.BetaMessageParam[],
    system: string | null,
    paused: Anthropic.Beta.BetaContentBlock[]
  ): number | null {
    if (remainingUsd === null) return null
    const price = this.deps.usage?.priceOf(model)
    if (!price || price.output <= 0) return null
    const inputTokens = this.estimateInputTokens(threadId, history, system, paused)
    const left = remainingUsd - spentUsd - (inputTokens * price.input) / 1_000_000
    return Math.max(0, Math.floor((left * 1_000_000) / price.output))
  }

  /**
   * 入力トークン数の見込み
   * 直前のリクエストの実測値（入力と、次の入力になる出力）に、新しいメッセージの分を足す。
   * 記録が無ければ全体を文字数から見積もる（1 文字を 1 トークンとして多めに数える）
   */
  private estimateInputTokens(
    threadId: string,
    history: Anthropic.Beta.BetaMessageParam[],
    system: string | null,
    paused: Anthropic.Beta.BetaContentBlock[]
  ): number {
    const measured = this.deps.usage?.contextOf(threadId).tokens ?? 0
    const latest = history.at(-1)
    const added =
      measured > 0 && latest
        ? roughTokens([latest])
        : roughTokens(history) + [...(system ?? '')].length
    const continued =
      paused.length > 0
        ? roughTokens([
            { role: 'assistant', content: paused as Anthropic.Beta.BetaContentBlockParam[] }
          ])
        : 0
    return measured + added + continued
  }

  private finish(
    assistantId: string,
    status: 'complete' | 'stopped' | 'error',
    content: string,
    contentBlocks: string | null,
    errorKind: ops.MessageRecord['error_kind'],
    stopReason: string | null,
    billing: { project: Project; threadId: string; entries: ModelUsage[] } | null,
    /** CHT-16: 実際に回答したモデル（拒否されて切り替わった場合） */
    servedModel?: string
  ): void {
    const { db } = this.deps
    let cost: number | null = null
    let tokens: number | null = null
    // 停止・エラーでも、API が受け付けた分は課金されるため記録する（フォールバックはモデルごとに記録する）
    for (const { model, usage: u } of billing?.entries ?? []) {
      const entryTokens =
        u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      if (entryTokens === 0) continue
      const entryCost = this.estimate(model, u)
      if (entryCost !== null) cost = (cost ?? 0) + entryCost
      tokens = (tokens ?? 0) + entryTokens
      ops.insertUsageRecord(db, {
        project_id: billing!.project.id,
        project_name: billing!.project.name,
        thread_id: billing!.threadId,
        message_id: assistantId,
        model,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        cache_write_tokens: u.cache_creation_input_tokens,
        estimated_cost: entryCost ?? 0
      })
    }
    ops.updateMessage(db, assistantId, {
      status,
      content,
      content_blocks: contentBlocks,
      error_kind: errorKind,
      stop_reason: stopReason,
      tokens_used: tokens,
      estimated_cost: cost,
      ...(servedModel ? { model: servedModel } : {})
    })
    const message = this.getPublic(assistantId)
    // 10.2: API 呼び出しの成否を記録する（本文は含めない）
    console.info(
      `[chat] request ${status}: model=${message.model ?? '-'} tokens=${tokens ?? 0}${errorKind ? ` error=${errorKind}` : ''}${stopReason ? ` stop=${stopReason}` : ''}`
    )
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
      attachments: attachments.map(toInfo),
      fallback: fallbackOf(record.content_blocks)
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

/**
 * メッセージのトークン数の大まかな見込み（USG-04。多めに見積もる）
 * 文字は 1 文字 1 トークン、画像は 1 枚あたり一定、PDF は大きさから見積もる
 */
function roughTokens(messages: Anthropic.Beta.BetaMessageParam[]): number {
  let tokens = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      tokens += [...m.content].length
      continue
    }
    for (const b of m.content) {
      const block = b as { type: string; text?: unknown; thinking?: unknown; source?: unknown }
      if (block.type === 'image') tokens += IMAGE_TOKENS
      else if (block.type === 'document') tokens += documentTokens(block.source)
      else if (typeof block.text === 'string') tokens += [...block.text].length
      else if (typeof block.thinking === 'string') tokens += [...block.thinking].length
      else tokens += JSON.stringify(block).length
    }
  }
  return tokens
}

function documentTokens(source: unknown): number {
  const s = source as { type?: string; data?: unknown } | undefined
  if (s?.type === 'text' && typeof s.data === 'string') return [...s.data].length
  // PDF（base64）: 1 ページを 50KB・3,000 トークン程度として、大きさから見積もる
  if (typeof s?.data === 'string') return Math.ceil((s.data.length * 3) / 4 / 16)
  return IMAGE_TOKENS
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

/**
 * 回答の出典（CHT-11）。本文の引用（web_search_result_location）を URL ごとにまとめる。
 * 結果を絞り込む版では本文に引用が付かないことがあるため、その場合は検索結果を（引用ではないと示して）返す
 */
function sourcesOf(record: ops.MessageRecord): WebSource[] {
  if (!record.content_blocks) return []
  const cited = new Map<string, WebSource>()
  const results = new Map<string, WebSource>()
  try {
    for (const block of JSON.parse(record.content_blocks) as {
      type: string
      citations?: { type: string; url?: string; title?: string | null }[] | null
      content?: unknown
    }[]) {
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location' && c.url && !cited.has(c.url)) {
          cited.set(c.url, { url: c.url, title: c.title ?? null, cited: true })
        }
      }
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content as { type?: string; url?: string; title?: string }[]) {
          if (r.type === 'web_search_result' && r.url && !results.has(r.url)) {
            results.set(r.url, { url: r.url, title: r.title ?? null, cited: false })
          }
        }
      }
    }
  } catch {
    return []
  }
  return cited.size > 0 ? [...cited.values()] : [...results.values()].slice(0, MAX_SEARCH_RESULTS)
}
