/**
 * Cowork の実行（要件 6.5〜6.7、9 章）
 * Agent SDK（Claude Code）を作業フォルダで実行し、すべてのツール実行を PreToolUse フックで判定する。
 *   - 境界の検証・権限モード・拒否リスト・確認ダイアログ・スナップショット・操作ログはフックで行う
 *   - 削除はアプリの削除ツール（.lumina-trash へ退避）に限る
 *   - 実行環境の設定（ユーザー全体の設定、プロジェクトの hooks など）は読み込まない
 */

import type {
  HookInput,
  HookJSONOutput,
  Options,
  Query,
  SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { activePath } from '@shared/conversation'
import { resolveModel } from '@shared/models'
import type {
  ApiErrorKind,
  ChatEvent,
  CoworkPrefs,
  EditAndResendInput,
  FileChange,
  Message,
  PermissionMethod,
  PermissionRequest,
  PermissionResponse,
  PermissionTarget,
  Project,
  SendMessageInput,
  SendResult,
  Thread,
  TodoItem,
  ToolCategory,
  ToolEventInfo
} from '@shared/types'
import { API_ERROR_MESSAGES } from '../api/errors'
import * as ops from '../db/operations'
import type { ModelService } from '../models/modelService'
import type { UsageService } from '../usage/usageService'
import type { TitleGenerator } from '../chat/titleGenerator'
import { buildSkillPlugin, getCoworkSettings, listSkills, SKILL_PLUGIN_NAME } from './extensions'
import type { McpStore } from './mcpStore'
import {
  classifyTool,
  decide,
  DEFAULT_COMMAND_DENY_PATTERNS,
  DELETE_TOOL,
  type AlwaysAllow,
  type Scope
} from './policy'
import {
  createSnapshot,
  listChanges,
  recordChange,
  snapshotDiff,
  undoRun,
  type UndoResult
} from './snapshot'
import {
  finishToolEvent,
  insertToolEvent,
  listToolEventsByThread,
  summarizeToolResponse
} from './toolEvents'
import type { GitSnapshots } from './gitSnapshot'
import { displayPath, rootFor, rootsOf, type FolderRoots } from './folders'
import { TASK_TOOLS, TaskTracker } from './tasks'
import { moveToTrash, sizeOf } from './trash'

const { ValidationError } = ops

/** Web のツール（6.6: プロジェクトの設定でオンにした場合のみ使える） */
const WEB_TOOLS = ['WebSearch', 'WebFetch']

/** Cowork で使えるツール（Web は既定でオフ。6.6） */
const TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  // COW-13: 作業の一覧（現在の Claude Code は Task 系のツール。以前の版は TodoWrite）
  'TodoWrite',
  ...TASK_TOOLS,
  'Agent'
]

/** 子プロセスに引き継ぐ環境変数（許可リスト方式。Phase 0 で他の認証情報の混入を確認済み） */
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'OS',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG'
]

const ERROR_KINDS: Partial<Record<string, ApiErrorKind>> = {
  authentication_failed: 'auth',
  billing_error: 'billing',
  rate_limit: 'rate_limit',
  overloaded: 'overloaded',
  invalid_request: 'bad_request',
  model_not_found: 'not_found',
  server_error: 'server'
}

const ALWAYS_KEY = (scope: Scope, id: string): string => `cowork.always.${scope}.${id}`
const DENY_KEY = 'cowork.denyPatterns'
const ALLOW_KEY = 'cowork.allowCommands'

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')

/** Agent SDK は ESM 専用のため、使うときに動的に読み込む */
const loadAgentSdk = (): Promise<AgentSdk> => import('@anthropic-ai/claude-agent-sdk')

export interface CoworkServiceDeps {
  db: Database.Database
  /** COW-10: Git のスナップショット */
  git?: Pick<GitSnapshots, 'snapshot'>
  snapshotsDir: string
  modelService: ModelService
  getApiKey: () => string | null
  emit: (event: ChatEvent) => void
  /** Agent SDK の設定・セッションの保存先（ユーザーの ~/.claude とは分ける） */
  configDir: string
  /** パッケージ化したアプリでの claude.exe のパス */
  executablePath?: string
  /** 全プロジェクト共通のカスタム指示（PRJ-08） */
  getGlobalInstructions?: () => string
  /** タイトルの自動生成（THR-03） */
  titles?: Pick<TitleGenerator, 'generate'>
  /** プロジェクトで設定した MCP サーバー（6.6） */
  mcp?: Pick<McpStore, 'toSdkConfig'>
  /** 信頼済みのスキルを渡すプラグインのフォルダの置き場所（6.6） */
  pluginsRoot?: string
  /** 上限の確認と概算コスト（USG）。テストでは省略できる */
  usage?: Pick<UsageService, 'check' | 'estimate'>
  /** テストで Agent SDK を差し替える */
  loadSdk?: () => Promise<Pick<AgentSdk, 'query' | 'tool' | 'createSdkMcpServer'>>
}

interface Pending {
  threadId: string
  request: PermissionRequest
  resolve: (response: PermissionResponse) => void
}

interface Run {
  controller: AbortController
  query: Query | null
  done: Promise<void>
}

/** Agent SDK の累計（モデル別） */
type ModelTotals = Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
>

export interface RunUsage {
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  cost: number
  /** 実行終了時点の累計（次の実行の基準にする） */
  total: ModelTotals
}

function parseTotals(raw: string | null | undefined): ModelTotals {
  try {
    return raw ? (JSON.parse(raw) as ModelTotals) : {}
  } catch {
    return {}
  }
}

function parseList(raw: string | null): ToolCategory[] {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(value) ? (value as ToolCategory[]) : []
  } catch {
    return []
  }
}

export class CoworkService {
  private readonly running = new Map<string, Run>()
  private readonly pending = new Map<string, Pending>()
  /** COW-13: スレッドごとの作業の一覧（再開したセッションでも続きから更新できるよう、スレッド単位で持つ） */
  private readonly tasks = new Map<string, TaskTracker>()
  private readonly loadSdk: () => Promise<Pick<AgentSdk, 'query' | 'tool' | 'createSdkMcpServer'>>

  constructor(private readonly deps: CoworkServiceDeps) {
    this.loadSdk = deps.loadSdk ?? loadAgentSdk
  }

  // ========================================
  // 設定（6.7 の常に許可、9.3 のコマンドの拒否・許可リスト）
  // ========================================

  getPrefs(): CoworkPrefs {
    const deny = ops.getSetting(this.deps.db, DENY_KEY)
    const allow = ops.getSetting(this.deps.db, ALLOW_KEY)
    return {
      denyPatterns: deny ? (JSON.parse(deny) as string[]) : DEFAULT_COMMAND_DENY_PATTERNS,
      allowCommands: allow ? (JSON.parse(allow) as string[]) : []
    }
  }

  setPrefs(input: Partial<CoworkPrefs>): CoworkPrefs {
    for (const pattern of input.denyPatterns ?? []) {
      try {
        new RegExp(pattern, 'i')
      } catch {
        throw new ValidationError(`正規表現として正しくありません: ${pattern}`)
      }
    }
    if (input.denyPatterns)
      ops.setSetting(this.deps.db, DENY_KEY, JSON.stringify(input.denyPatterns))
    if (input.allowCommands) {
      ops.setSetting(this.deps.db, ALLOW_KEY, JSON.stringify(input.allowCommands))
    }
    return this.getPrefs()
  }

  getAlways(projectId: string, threadId: string): AlwaysAllow {
    return {
      thread: parseList(ops.getSetting(this.deps.db, ALWAYS_KEY('thread', threadId))),
      project: parseList(ops.getSetting(this.deps.db, ALWAYS_KEY('project', projectId)))
    }
  }

  /** 「常に許可」の解除（6.7: 設定画面から解除できる） */
  clearAlways(scope: Scope, id: string): void {
    ops.deleteSetting(this.deps.db, ALWAYS_KEY(scope, id))
  }

  private addAlways(scope: Scope, id: string, category: ToolCategory): void {
    const list = parseList(ops.getSetting(this.deps.db, ALWAYS_KEY(scope, id)))
    if (!list.includes(category)) list.push(category)
    ops.setSetting(this.deps.db, ALWAYS_KEY(scope, id), JSON.stringify(list))
  }

  // ========================================
  // 実行
  // ========================================

  send(input: SendMessageInput): SendResult {
    if (input.attachmentIds.length > 0) {
      throw new ValidationError(
        'Cowork では添付ファイルは使えません。作業フォルダにファイルを置いて指示してください。'
      )
    }
    const { thread, project, model, workRoot } = this.prepare(input.threadId)
    if (input.content.trim() === '') throw new ValidationError('メッセージを入力してください。')
    const parent = this.path(thread.id).at(-1) ?? null
    const user = ops.createMessage(this.deps.db, {
      thread_id: thread.id,
      parent_id: parent?.id ?? null,
      role: 'user',
      content: input.content
    })
    if (thread.title === null) this.setTitle(thread.id, input.content)
    const assistant = this.start(project, thread, user, model, workRoot, {
      resume: thread.agent_session_id ?? undefined
    })
    return { userMessage: this.toPublic(user), assistantMessage: assistant }
  }

  /** 停止・エラー後の再実行。前回の実行の直前まで巻き戻して、同じ指示で実行し直す */
  regenerate(userMessageId: string): Message {
    const user = this.latestUser(userMessageId)
    const { thread, project, model, workRoot } = this.prepare(user.thread_id)
    return this.start(project, thread, user, model, workRoot, this.forkPoint(thread, user))
  }

  /**
   * 最新の指示を編集して再実行する（CHT-14）
   * 前回の変更を元に戻すかどうかは、画面で確認してから undo を呼ぶ（自動では戻さない）。
   */
  editAndResend(input: EditAndResendInput): SendResult {
    const original = this.latestUser(input.userMessageId)
    const { thread, project, model, workRoot } = this.prepare(original.thread_id)
    if (input.content.trim() === '') throw new ValidationError('メッセージを入力してください。')
    const user = ops.createMessage(this.deps.db, {
      thread_id: thread.id,
      parent_id: original.parent_id,
      role: 'user',
      content: input.content
    })
    const assistant = this.start(
      project,
      thread,
      user,
      model,
      workRoot,
      this.forkPoint(thread, original)
    )
    return { userMessage: this.toPublic(user), assistantMessage: assistant }
  }

  /** 実行の中断（COW-06: それまでの変更は保持し、Undo の対象になる） */
  stop(threadId: string): void {
    const run = this.running.get(threadId)
    if (!run) return
    for (const [id, p] of this.pending) {
      if (p.threadId === threadId) {
        p.resolve('deny')
        this.pending.delete(id)
      }
    }
    run.controller.abort()
    void run.query?.interrupt().catch(() => undefined)
  }

  /** 確認ダイアログの回答 */
  respond(requestId: string, response: PermissionResponse): void {
    const p = this.pending.get(requestId)
    if (!p) throw new ValidationError('確認の依頼が見つかりません（すでに終了しています）。')
    this.pending.delete(requestId)
    p.resolve(response)
  }

  /** 回答待ちの確認（画面を開き直したときに表示し直すため） */
  pendingRequests(threadId: string): PermissionRequest[] {
    return [...this.pending.values()].filter((p) => p.threadId === threadId).map((p) => p.request)
  }

  isGenerating(threadId: string): boolean {
    return this.running.has(threadId)
  }

  activeThreadIds(): string[] {
    return [...this.running.keys()]
  }

  async whenIdle(threadId?: string): Promise<void> {
    const runs = threadId ? [this.running.get(threadId)] : [...this.running.values()]
    await Promise.all(runs.map((r) => r?.done))
  }

  listToolEvents(threadId: string): ToolEventInfo[] {
    return listToolEventsByThread(this.deps.db, threadId)
  }

  // ========================================
  // 変更の確認・取り消し（SEC-15、SEC-16）
  // ========================================

  listChanges(messageId: string): FileChange[] {
    const { workRoot } = this.contextOfMessage(messageId)
    return listChanges(this.deps.db, workRoot, messageId)
  }

  undo(messageId: string): UndoResult {
    const { threadId, workRoot } = this.contextOfMessage(messageId)
    if (this.running.has(threadId)) {
      throw new ValidationError('実行中は元に戻せません。先に停止してください。')
    }
    const { writeRoots } = rootsOf(this.deps.db, this.projectIdOfThread(threadId), workRoot)
    return undoRun(this.deps.db, this.deps.snapshotsDir, workRoot, messageId, writeRoots)
  }

  diff(snapshotId: string): ReturnType<typeof snapshotDiff> {
    const row = this.deps.db
      .prepare('SELECT message_id FROM snapshots WHERE id = ?')
      .get(snapshotId) as { message_id: string | null } | undefined
    if (!row?.message_id) return null
    const { workRoot } = this.contextOfMessage(row.message_id)
    return snapshotDiff(this.deps.db, this.deps.snapshotsDir, workRoot, snapshotId)
  }

  // ========================================
  // 内部
  // ========================================

  private prepare(threadId: string): {
    thread: Thread & { agent_session_id?: string | null }
    project: Project
    model: string
    workRoot: string
  } {
    if (this.deps.getApiKey() === null) {
      throw new ValidationError('API キーが設定されていません。設定画面で登録してください。')
    }
    const thread = this.getThread(threadId)
    const project = ops.getProject(this.deps.db, thread.project_id)!
    if (project.type !== 'cowork' || !project.work_folder) {
      throw new ValidationError('Cowork のプロジェクトではありません。')
    }
    // PRJ-06: 作業フォルダが無ければ実行しない
    if (!existsSync(project.work_folder) || !statSync(project.work_folder).isDirectory()) {
      throw new ValidationError(
        '作業フォルダが見つかりません（移動・削除された可能性があります）。プロジェクトの編集で再指定してください。'
      )
    }
    if (this.running.has(threadId)) {
      throw new ValidationError('実行中です。停止してから送信してください。')
    }
    const model = resolveModel(
      this.deps.modelService.getDefaultModel(),
      project.model,
      thread.model
    )
    if (!model) throw new ValidationError('モデルが選択されていません。')
    // USG-04: 上限に達していれば停止する
    this.deps.usage?.check(project.id)
    return { thread, project, model, workRoot: project.work_folder }
  }

  private getThread(threadId: string): Thread & { agent_session_id: string | null } {
    const thread = ops.getThread(this.deps.db, threadId)
    if (!thread) throw new ValidationError('スレッドが見つかりません。')
    const row = this.deps.db
      .prepare('SELECT agent_session_id FROM threads WHERE id = ?')
      .get(threadId) as { agent_session_id: string | null }
    return { ...thread, agent_session_id: row.agent_session_id }
  }

  private projectIdOfThread(threadId: string): string {
    return ops.getThread(this.deps.db, threadId)!.project_id
  }

  private contextOfMessage(messageId: string): { threadId: string; workRoot: string } {
    const message = ops.getMessage(this.deps.db, messageId)
    if (!message) throw new ValidationError('メッセージが見つかりません。')
    const thread = ops.getThread(this.deps.db, message.thread_id)!
    const project = ops.getProject(this.deps.db, thread.project_id)!
    return { threadId: thread.id, workRoot: project.work_folder ?? '' }
  }

  /** 表示中の分岐（CHT-06） */
  private path(threadId: string): ops.MessageRecord[] {
    const thread = ops.getThread(this.deps.db, threadId)
    return activePath(ops.listMessagesByThread(this.deps.db, threadId), thread?.active_leaf_id)
  }

  private latestUser(userMessageId: string): ops.MessageRecord {
    const target = ops.getMessage(this.deps.db, userMessageId)
    if (!target || target.role !== 'user') throw new ValidationError('メッセージが見つかりません。')
    const latest = this.path(target.thread_id)
      .filter((m) => m.role === 'user')
      .at(-1)
    if (latest?.id !== target.id) {
      throw new ValidationError('編集・再実行できるのは最新の指示だけです。')
    }
    return target
  }

  /** 指定したユーザーメッセージの直前まで巻き戻して再開する位置 */
  private forkPoint(
    thread: { agent_session_id?: string | null },
    user: ops.MessageRecord
  ): Pick<Options, 'resume' | 'resumeSessionAt' | 'forkSession'> {
    const parent = user.parent_id ? ops.getMessage(this.deps.db, user.parent_id) : null
    const uuid = parent?.agent_resume_uuid
    if (!thread.agent_session_id || !uuid) return {}
    return { resume: thread.agent_session_id, resumeSessionAt: uuid, forkSession: true }
  }

  private setTitle(threadId: string, content: string): void {
    const line = content.trim().split(/\r?\n/)[0] ?? ''
    const chars = [...line]
    if (chars.length === 0) return
    ops.updateThread(this.deps.db, threadId, {
      title: chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : line,
      title_source: 'auto'
    })
  }

  private toPublic(record: ops.MessageRecord): Message {
    const {
      content_blocks: _blocks,
      agent_resume_uuid: _resume,
      agent_usage_total: _total,
      ...rest
    } = record
    void _blocks
    void _resume
    void _total
    return { ...rest, thinking: null, sources: [], attachments: [], fallback: null }
  }

  private start(
    project: Project,
    thread: Thread,
    user: ops.MessageRecord,
    model: string,
    workRoot: string,
    resume: Pick<Options, 'resume' | 'resumeSessionAt' | 'forkSession'>
  ): Message {
    const assistant = ops.createMessage(this.deps.db, {
      thread_id: thread.id,
      parent_id: user.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model
    })
    // CHT-06: 新しい応答を表示中の分岐にする
    ops.updateThread(this.deps.db, thread.id, { active_leaf_id: assistant.id })
    // SDK の累計は再開したセッションの以前の分を含む。分岐（fork）した場合も、巻き戻した位置ではなく
    // 元のセッション全体の累計から続く（実 API で確認）。そのため、スレッドで最後に実行した回の累計を基準にする
    const latest = this.deps.db
      .prepare(
        `SELECT agent_usage_total FROM messages
         WHERE thread_id = ? AND agent_usage_total IS NOT NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(thread.id) as { agent_usage_total: string } | undefined
    const baseline = resume.resume ? parseTotals(latest?.agent_usage_total) : {}
    // USG-04: 実行中に上限に達したら中断する（SDK の予算上限。ターン単位のため厳密ではない）
    const budget = this.deps.usage?.check(project.id).remainingUsd ?? null
    const controller = new AbortController()
    const run: Run = { controller, query: null, done: Promise.resolve() }
    run.done = this.execute(
      run,
      project,
      thread.id,
      assistant.id,
      user.content,
      model,
      workRoot,
      resume,
      baseline,
      budget
    )
      .catch((error) => {
        console.error('[cowork] unexpected failure:', (error as Error).message)
        this.finish(project, thread.id, assistant.id, 'error', '', 'unknown', null, null)
      })
      // 完了の通知の後に次の実行が始まっていれば、そちらは消さない
      .finally(() => {
        if (this.running.get(thread.id) === run) this.running.delete(thread.id)
      })
    this.running.set(thread.id, run)
    return this.toPublic(assistant)
  }

  private systemAppend(project: Project, workRoot: string, roots: FolderRoots): string {
    const parts = [
      'あなたは Lumina Code の Cowork として、作業フォルダ内のファイルを操作します。',
      `作業フォルダ: ${workRoot}`,
      ...(roots.writeRoots.length > 0
        ? [`読み書きできる追加のフォルダ: ${roots.writeRoots.join('、')}`]
        : []),
      ...(roots.readRoots.length > 0
        ? [
            `読み取り専用の追加のフォルダ（参照のみ。書き込み・削除はできません）: ${roots.readRoots.join('、')}`
          ]
        : []),
      '上記以外のフォルダのファイルにはアクセスできません。追加のフォルダは絶対パスで指定してください。',
      `ファイルやフォルダを削除するときは、コマンド（rm、del、Remove-Item など）ではなく、必ず ${DELETE_TOOL} ツールを使ってください。削除したものは作業フォルダの .lumina-trash に退避されます。`,
      'ツールの実行が拒否された場合は、理由に従い、別の方法を無理に試さずにユーザーへ報告してください。'
    ]
    // PRJ-08: グローバル → プロジェクトの順
    const global = this.deps.getGlobalInstructions?.() ?? ''
    if (global.trim()) parts.push(`\n# 共通のカスタム指示\n${global.trim()}`)
    if (project.custom_instructions)
      parts.push(`\n# プロジェクトのカスタム指示\n${project.custom_instructions}`)
    // COW-11: 作業フォルダの CLAUDE.md を指示として適用する（設定ファイルの hooks などは読み込まない）
    const claudeMd = join(workRoot, 'CLAUDE.md')
    if (existsSync(claudeMd)) {
      try {
        parts.push(
          `\n# 作業フォルダの CLAUDE.md\n${readFileSync(claudeMd, 'utf-8').slice(0, 40_000)}`
        )
      } catch {
        // 読めない場合は使わない
      }
    }
    return parts.join('\n')
  }

  private buildEnv(apiKey: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    return {
      ...env,
      ANTHROPIC_API_KEY: apiKey,
      CLAUDE_CONFIG_DIR: this.deps.configDir,
      // SEC-33: Claude API 以外への送信（利用統計・エラー報告・自動更新）を行わない
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      // 6.6: Cowork は依頼ごとに実行して終わるため、サブエージェントやコマンドをバックグラウンドで動かさない
      // （バックグラウンドの結果は回答に入らず、実行の終了時に打ち切られる）
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'lumina-code'
    }
  }

  private async execute(
    run: Run,
    project: Project,
    threadId: string,
    assistantId: string,
    prompt: string,
    model: string,
    workRoot: string,
    resume: Pick<Options, 'resume' | 'resumeSessionAt' | 'forkSession'>,
    baseline: ModelTotals,
    budget: number | null
  ): Promise<void> {
    const { db, emit } = this.deps
    const apiKey = this.deps.getApiKey()
    if (apiKey === null) {
      return this.finish(project, threadId, assistantId, 'error', '', 'auth', null, null)
    }
    const signal = run.controller.signal
    const recorded = new Set<string>()
    const { query, tool, createSdkMcpServer } = await this.loadSdk()
    const settings = getCoworkSettings(db, project.id)
    const webAccess = settings.webAccess
    // COW-12: 追加のフォルダ（読み書き・読み取り専用）
    const roots = rootsOf(db, project.id, workRoot)
    // COW-10: 実行前に Git のスナップショットを記録する（失敗しても実行は続ける）
    if (settings.gitSnapshots && this.deps.git) {
      try {
        const title = ops.getThread(db, threadId)?.title ?? '無題のスレッド'
        await this.deps.git.snapshot(workRoot, `Cowork の実行前: ${title}`)
      } catch (error) {
        console.warn('[cowork] git snapshot failed:', (error as Error).message)
      }
    }
    let skillPlugin: string | null = null
    if (this.deps.pluginsRoot) {
      try {
        skillPlugin = buildSkillPlugin(db, project.id, workRoot, this.deps.pluginsRoot)
      } catch (error) {
        console.warn('[cowork] skills were not loaded:', (error as Error).message)
      }
    }
    const threadRow = ops.getThread(db, threadId)
    const modelInfo = this.deps.modelService.getModelInfo(model)
    const effort =
      threadRow?.effort && modelInfo?.effort_levels.includes(threadRow.effort)
        ? threadRow.effort
        : null

    // 削除ツール（SEC-10）。実行前に PreToolUse フックで確認済み
    const deleteTool = tool(
      'delete_files',
      '作業フォルダ内のファイル・フォルダを削除します（.lumina-trash に退避し、あとで復元できます）。パスは作業フォルダからの相対パスで指定します（読み書きできる追加のフォルダは絶対パスで指定します）。',
      { paths: z.array(z.string()).min(1).max(100) },
      async ({ paths }) => {
        // COW-12: フォルダごとに、それぞれの .lumina-trash に退避する
        const groups = new Map<string, string[]>()
        for (const p of paths) {
          const absolute = resolve(workRoot, p)
          const root = rootFor([workRoot, ...roots.writeRoots], absolute) ?? workRoot
          groups.set(root, [...(groups.get(root) ?? []), absolute])
        }
        const moved = [...groups].flatMap(([root, list]) => moveToTrash(root, list))
        for (const m of moved) {
          recordChange(db, {
            threadId,
            messageId: assistantId,
            filePath: m.originalPath,
            kind: 'trashed',
            trashPath: m.trashPath
          })
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `${moved.length} 件を .lumina-trash に退避しました: ${moved.map((m) => displayPath(workRoot, m.originalPath)).join(', ')}`
            }
          ]
        }
      }
    )

    const preToolUse = async (
      input: HookInput,
      toolUseId: string | undefined,
      options?: { signal: AbortSignal }
    ): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return { continue: true }
      // SDK 側でフックが打ち切られた場合も、確認を閉じる
      const hookSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal
      const verdict = await this.judge(
        project,
        threadId,
        assistantId,
        workRoot,
        input.tool_name,
        input.tool_input,
        toolUseId ?? input.tool_use_id,
        hookSignal,
        recorded,
        input.agent_id ?? null,
        webAccess,
        skillPlugin,
        roots
      )
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict.allow ? 'allow' : 'deny',
          ...(verdict.reason ? { permissionDecisionReason: verdict.reason } : {})
        }
      }
    }
    const postToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
      if (input.hook_event_name === 'PostToolUse') {
        const event = finishToolEvent(
          db,
          input.tool_use_id,
          summarizeToolResponse(input.tool_name, input.tool_response)
        )
        if (event) emit({ type: 'tool', threadId, messageId: assistantId, event })
        if (TASK_TOOLS.includes(input.tool_name)) {
          let tracker = this.tasks.get(threadId)
          if (!tracker) this.tasks.set(threadId, (tracker = new TaskTracker()))
          const todos = tracker.apply(input.tool_name, input.tool_input, input.tool_response)
          if (todos) emit({ type: 'todos', threadId, messageId: assistantId, todos })
        }
      } else if (input.hook_event_name === 'PostToolUseFailure') {
        const event = finishToolEvent(db, input.tool_use_id, `エラー: ${input.error}`)
        if (event) emit({ type: 'tool', threadId, messageId: assistantId, event })
      }
      return { continue: true }
    }

    const options: Options = {
      cwd: workRoot,
      // COW-12: 追加のフォルダ（読み書き・読み取り専用の区別はフックで判定する）
      ...(roots.writeRoots.length + roots.readRoots.length > 0
        ? { additionalDirectories: [...roots.writeRoots, ...roots.readRoots] }
        : {}),
      model,
      env: this.buildEnv(apiKey),
      abortController: run.controller,
      includePartialMessages: true,
      settingSources: [],
      // 6.6: Web は設定でオンにした場合のみ。スキルは信頼済みの場合のみ
      tools: [...TOOLS, ...(webAccess ? WEB_TOOLS : []), ...(skillPlugin ? ['Skill'] : [])],
      disallowedTools: webAccess ? [] : WEB_TOOLS,
      mcpServers: {
        ...((this.deps.mcp?.toSdkConfig(project.id) ?? {}) as Options['mcpServers']),
        lumina: createSdkMcpServer({ name: 'lumina', tools: [deleteTool] })
      },
      // 6.6: 有効にするのは信頼済みのプロジェクトのスキルだけ（Claude Code の組み込みのスキルは使わない）
      ...(skillPlugin
        ? {
            plugins: [{ type: 'local' as const, path: skillPlugin, skipMcpDiscovery: true }],
            skills: listSkills(workRoot).map((skill) => `${SKILL_PLUGIN_NAME}:${skill.name}`)
          }
        : { skills: [] }),
      permissionMode: project.permission_mode === 'plan_only' ? 'plan' : 'default',
      // フックで判定済みのため、ここに来るのは想定外の確認要求のみ。安全側で拒否する
      canUseTool: async (name) => ({
        behavior: 'deny',
        message: `確認できない操作のため拒否しました: ${name}`
      }),
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }],
        PostToolUse: [{ hooks: [postToolUse] }],
        PostToolUseFailure: [{ hooks: [postToolUse] }]
      },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: this.systemAppend(project, workRoot, roots)
      },
      ...(this.deps.executablePath ? { pathToClaudeCodeExecutable: this.deps.executablePath } : {}),
      ...(budget !== null ? { maxBudgetUsd: budget } : {}),
      // CHT-07: 思考量（モデルが対応している場合のみ）。思考のオン／オフは通常チャットのみ
      // （思考を止められないモデルがあり、止めると Agent SDK の実行が失敗するおそれがあるため）
      ...(effort ? { effort } : {}),
      ...resume
    }

    const texts: string[] = []
    let lastUuid: string | null = null
    let errorKind: ApiErrorKind | null = null
    try {
      const q = query({ prompt, options })
      run.query = q
      for await (const message of q as AsyncIterable<SDKMessage>) {
        if (message.type === 'system' && message.subtype === 'init') {
          db.prepare('UPDATE threads SET agent_session_id = ? WHERE id = ?').run(
            message.session_id,
            threadId
          )
          const pluginErrors = (message as { plugin_errors?: { message?: string }[] }).plugin_errors
          if (pluginErrors?.length) {
            console.warn(`[cowork] plugin errors: ${pluginErrors.map((e) => e.message).join('; ')}`)
          }
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          emit({
            type: 'retrying',
            threadId,
            messageId: assistantId,
            attempt: message.attempt,
            maxAttempts: message.max_retries,
            waitMs: message.retry_delay_ms,
            message: API_ERROR_MESSAGES[ERROR_KINDS[message.error] ?? 'server']
          })
        } else if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
          const event = message.event
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            emit({ type: 'text', threadId, messageId: assistantId, text: event.delta.text })
          }
        } else if (message.type === 'assistant') {
          if (message.parent_tool_use_id === null) {
            lastUuid = message.uuid
            if (message.error) errorKind = ERROR_KINDS[message.error] ?? 'unknown'
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text.trim()) texts.push(block.text)
              if (block.type === 'tool_use' && block.name === 'TodoWrite') {
                const todos = (block.input as { todos?: TodoItem[] }).todos ?? []
                emit({ type: 'todos', threadId, messageId: assistantId, todos })
              }
            }
            // テキストの区切り（ツール実行の前後）を画面にも反映する
            emit({ type: 'text', threadId, messageId: assistantId, text: '\n\n' })
          }
        } else if (message.type === 'result') {
          const usage = this.runUsage(message.modelUsage ?? {}, baseline)
          if (message.subtype === 'error_max_budget_usd') errorKind = 'budget'
          const content = texts.join('\n\n')
          if (message.subtype === 'success' && !message.is_error) {
            return this.finish(
              project,
              threadId,
              assistantId,
              'complete',
              content,
              null,
              lastUuid,
              usage
            )
          }
          if (signal.aborted) {
            return this.finish(
              project,
              threadId,
              assistantId,
              'stopped',
              content,
              null,
              lastUuid,
              usage
            )
          }
          return this.finish(
            project,
            threadId,
            assistantId,
            'error',
            content,
            errorKind ?? 'unknown',
            lastUuid,
            usage
          )
        }
      }
      // 結果が届かずに終わった場合
      const content = texts.join('\n\n')
      return this.finish(
        project,
        threadId,
        assistantId,
        signal.aborted ? 'stopped' : 'error',
        content,
        signal.aborted ? null : (errorKind ?? 'unknown'),
        lastUuid,
        null
      )
    } catch (error) {
      const content = texts.join('\n\n')
      if (signal.aborted) {
        return this.finish(project, threadId, assistantId, 'stopped', content, null, lastUuid, null)
      }
      console.error('[cowork] query failed:', (error as Error).message)
      return this.finish(
        project,
        threadId,
        assistantId,
        'error',
        content,
        errorKind ?? 'unknown',
        lastUuid,
        null
      )
    }
  }

  /**
   * ツール実行の判定（PreToolUse フック）
   */
  private async judge(
    project: Project,
    threadId: string,
    messageId: string,
    workRoot: string,
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
    signal: AbortSignal,
    recorded: Set<string>,
    agentId: string | null = null,
    webAccess = false,
    skillPlugin: string | null = null,
    roots: FolderRoots = { workRoot, writeRoots: [], readRoots: [] }
  ): Promise<{ allow: boolean; reason?: string }> {
    const { db, emit } = this.deps
    // 信頼済みのスキルのコピーと、読み取り専用の追加フォルダ（COW-12）は読み取りのみ許す
    const readRoots = [...(skillPlugin ? [skillPlugin] : []), ...roots.readRoots]
    const classified = classifyTool(toolName, toolInput, workRoot, readRoots, roots.writeRoots)
    const includesFolder = classified.paths.some((p) => existsSync(p) && statSync(p).isDirectory())
    const current = ops.getProject(db, project.id) ?? project
    const decision = decide(classified, {
      mode: current.permission_mode,
      always: this.getAlways(project.id, threadId),
      commandRules: this.getPrefs(),
      workRoot,
      includesFolder,
      webAccess,
      // コマンドでパスを指定できるのは、スキルのコピーと読み書きの追加フォルダ
      extraRoots: [...(skillPlugin ? [skillPlugin] : []), ...roots.writeRoots]
    })

    const target =
      classified.paths.map((p) => displayPath(workRoot, p)).join(', ') ||
      (typeof (toolInput as { pattern?: unknown })?.pattern === 'string'
        ? String((toolInput as { pattern: string }).pattern)
        : null)
    const log = (method: PermissionMethod, result?: string): void => {
      const event = insertToolEvent(db, {
        threadId,
        messageId,
        toolUseId,
        toolName,
        category: classified.category,
        target,
        command: classified.command ?? null,
        method,
        result,
        agentId
      })
      emit({ type: 'tool', threadId, messageId, event })
    }

    let method: PermissionMethod
    if (decision.action === 'deny') {
      // SEC-03: 拒否はログに残し、画面に表示する
      log('denied', `拒否: ${decision.reason}`)
      return { allow: false, reason: decision.reason }
    } else if (decision.action === 'allow') {
      method = decision.method
    } else {
      const response = await this.ask(
        {
          requestId: randomUUID(),
          threadId,
          toolName,
          category: classified.category,
          targets: classified.paths.map((p) => this.describeTarget(workRoot, p)),
          command: classified.command ?? null,
          detail: this.describeDetail(toolName, toolInput),
          danger: decision.reason ?? null,
          offerAlways: decision.offerAlways
        },
        signal
      )
      if (response === 'deny') {
        log('denied', '拒否: ユーザーが拒否しました')
        return { allow: false, reason: 'ユーザーが拒否しました。' }
      }
      if (response !== 'once' && decision.offerAlways) {
        this.addAlways(response, response === 'thread' ? threadId : project.id, classified.category)
      }
      method =
        response === 'thread'
          ? 'allowed_always_thread'
          : response === 'project'
            ? 'allowed_always_project'
            : 'allowed_once'
    }

    // SEC-14: 変更・上書きの前に、変更前の内容を保存する（実行内で最初の 1 回）
    if (classified.category === 'write') {
      for (const path of classified.paths) {
        const key = path.toLowerCase()
        if (recorded.has(key)) continue
        recorded.add(key)
        if (existsSync(path) && statSync(path).isFile()) {
          createSnapshot(db, this.deps.snapshotsDir, threadId, path, messageId)
        } else if (!existsSync(path)) {
          recordChange(db, { threadId, messageId, filePath: path, kind: 'created' })
        }
      }
    }
    log(method)
    return { allow: true }
  }

  private ask(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResponse> {
    if (signal.aborted) return Promise.resolve('deny')
    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (this.pending.delete(request.requestId)) resolve('deny')
      }
      this.pending.set(request.requestId, {
        threadId: request.threadId,
        request,
        resolve: (response) => {
          signal.removeEventListener('abort', onAbort)
          resolve(response)
        }
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.deps.emit({ type: 'permission', threadId: request.threadId, request })
    })
  }

  private describeTarget(workRoot: string, path: string): PermissionTarget {
    const rel = displayPath(workRoot, path)
    if (!existsSync(path)) return { path: rel, kind: 'missing', size_bytes: null }
    const folder = statSync(path).isDirectory()
    let size: number | null = null
    try {
      size = sizeOf(path)
    } catch {
      // サイズが取れなくても確認は続ける
    }
    return { path: rel, kind: folder ? 'folder' : 'file', size_bytes: size }
  }

  private describeDetail(toolName: string, input: unknown): string | null {
    const args = (input ?? {}) as Record<string, unknown>
    const clip = (s: unknown): string => {
      const text = typeof s === 'string' ? s : ''
      return text.length > 1500 ? `${text.slice(0, 1500)}…` : text
    }
    if (toolName === 'Write') return clip(args['content'])
    if (toolName === 'Edit') return `- ${clip(args['old_string'])}\n+ ${clip(args['new_string'])}`
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      return typeof args['description'] === 'string' ? args['description'] : null
    }
    // Web 取得では、取得した内容をどう使うかの指示を示す
    if (toolName === 'WebFetch') return clip(args['prompt'])
    return null
  }

  /**
   * この実行の使用量（累計と基準の差分）と概算コスト（USG-01、USG-05: アプリの単価表で計算する）
   */
  private runUsage(
    modelUsage: Record<
      string,
      {
        inputTokens: number
        outputTokens: number
        cacheReadInputTokens: number
        cacheCreationInputTokens: number
        costUSD: number
      }
    >,
    baseline: ModelTotals
  ): RunUsage {
    const total: ModelTotals = {}
    const result: RunUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      total
    }
    for (const [model, u] of Object.entries(modelUsage)) {
      total[model] = {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadInputTokens ?? 0,
        cacheWrite: u.cacheCreationInputTokens ?? 0,
        cost: u.costUSD ?? 0
      }
      const base = baseline[model]
      // 基準より少ない場合は、新しいセッションとして数え直す
      const reset = base && total[model].input + total[model].output < base.input + base.output
      const d = (key: keyof ModelTotals[string]): number =>
        Math.max(0, total[model][key] - (base && !reset ? base[key] : 0))
      const delta = {
        input_tokens: d('input'),
        output_tokens: d('output'),
        cache_read_input_tokens: d('cacheRead'),
        cache_creation_input_tokens: d('cacheWrite')
      }
      result.input_tokens += delta.input_tokens
      result.output_tokens += delta.output_tokens
      result.cache_read += delta.cache_read_input_tokens
      result.cache_write += delta.cache_creation_input_tokens
      // 単価表に無いモデルは SDK の概算を使う
      result.cost += this.deps.usage?.estimate(model, delta) ?? d('cost')
    }
    return result
  }

  private finish(
    project: Project,
    threadId: string,
    assistantId: string,
    status: 'complete' | 'stopped' | 'error',
    content: string,
    errorKind: ApiErrorKind | null,
    resumeUuid: string | null,
    usage: RunUsage | null
  ): void {
    const { db } = this.deps
    if (
      usage &&
      usage.input_tokens + usage.output_tokens + usage.cache_read + usage.cache_write > 0
    ) {
      ops.insertUsageRecord(db, {
        project_id: project.id,
        project_name: project.name,
        thread_id: threadId,
        message_id: assistantId,
        model: ops.getMessage(db, assistantId)?.model ?? '',
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read,
        cache_write_tokens: usage.cache_write,
        estimated_cost: usage.cost
      })
    }
    ops.updateMessage(db, assistantId, {
      status,
      content,
      error_kind: errorKind,
      tokens_used: usage
        ? usage.input_tokens + usage.output_tokens + usage.cache_read + usage.cache_write
        : null,
      estimated_cost: usage?.cost ?? null
    })
    db.prepare('UPDATE messages SET agent_resume_uuid = ?, agent_usage_total = ? WHERE id = ?').run(
      resumeUuid,
      usage ? JSON.stringify(usage.total) : null,
      assistantId
    )
    // 10.2: 実行の成否を記録する（本文は含めない）
    console.info(
      `[cowork] run ${status}: tokens=${usage ? usage.input_tokens + usage.output_tokens : 0}${errorKind ? ` error=${errorKind}` : ''}`
    )
    const message = this.toPublic(ops.getMessage(db, assistantId)!)
    // 完了の通知を受けてすぐ Undo・次の指示ができるよう、通知より先に「実行中」を解除する
    this.running.delete(threadId)
    this.deps.emit({
      type: 'finished',
      threadId,
      message,
      errorMessage: errorKind ? API_ERROR_MESSAGES[errorKind] : null
    })

    // THR-03: 最初の実行が完了したらタイトルを作る
    if (status === 'complete' && this.deps.titles) {
      const thread = ops.getThread(db, threadId)
      const path = this.path(threadId)
      if (thread?.title_source === 'auto' && path.length === 2 && path[0].role === 'user') {
        void this.deps.titles.generate(threadId, path[0].content, content, message.model ?? '')
      }
    }
  }
}
