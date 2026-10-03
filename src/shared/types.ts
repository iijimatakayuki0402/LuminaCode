/**
 * main と renderer で共有するエンティティ型（要件定義書 8 章）
 */

import type { Accent, Mode } from './theme'

export type ProjectType = 'chat' | 'cowork'
export type PermissionMode = 'confirm_each' | 'auto_edit' | 'plan_only'
export type MessageRole = 'user' | 'assistant'

/** 思考量（CHT-07。Messages API の output_config.effort） */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface Project {
  id: string
  type: ProjectType
  name: string
  custom_instructions: string | null
  work_folder: string | null
  model: string | null
  permission_mode: PermissionMode
  pinned: boolean
  archived: boolean
  created_at: number
  updated_at: number
}

/** スレッドの色ラベル（THR-06） */
export type ThreadColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'
export const THREAD_COLORS: ThreadColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']
/** タグの上限（THR-06） */
export const THREAD_TAGS_MAX = 10
export const THREAD_TAG_LENGTH_MAX = 20

export interface Thread {
  id: string
  project_id: string
  title: string | null
  model: string | null
  extended_thinking: boolean
  last_opened_at: number | null
  created_at: number
  updated_at: number
  /** 表示中の分岐の末端（CHT-06） */
  active_leaf_id: string | null
  /** 思考量（CHT-07）。null はモデルの既定 */
  effort: EffortLevel | null
  /** 要約して続けたスレッドの、元の会話の要約（CTX-02） */
  context_summary: string | null
  /** タイトルの由来（THR-03） */
  title_source: 'auto' | 'ai' | 'manual'
  /** 色ラベル（THR-06）。null は無し */
  color: ThreadColor | null
  /** タグ（THR-06） */
  tags: string[]
}

/**
 * 応答の状態
 *   streaming 生成中 / complete 完了 / stopped 停止（CHT-04、途中までを保持）/
 *   error エラー / interrupted 異常終了で中断（6.14）
 */
export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error' | 'interrupted'

/**
 * API エラーの種別（要件 6.14）
 * auth・permission は API キーの再設定、billing はコンソールの確認を促す
 */
export type ApiErrorKind =
  | 'auth'
  | 'permission'
  | 'billing'
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'offline'
  | 'timeout'
  | 'too_large'
  | 'bad_request'
  | 'not_found'
  /** 使用量の上限に達したため中断した（USG-04） */
  | 'budget'
  | 'unknown'

export type AttachmentKind = 'image' | 'pdf' | 'text'

export interface AttachmentInfo {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  kind: AttachmentKind
  /** 画像のサムネイル（data URL）。送信前のプレビュー用（ATT-05） */
  preview?: string
}

export interface Message {
  id: string
  thread_id: string
  /** 分岐用の親メッセージ（CHT-14 の編集・再送信で、同じ親を持つ兄弟ができる） */
  parent_id: string | null
  role: MessageRole
  content: string
  tokens_used: number | null
  estimated_cost: number | null
  created_at: number
  status: MessageStatus
  /** 応答に使ったモデル */
  model: string | null
  stop_reason: string | null
  error_kind: ApiErrorKind | null
  /** 思考の要約（折りたたみ表示用。CHT-07） */
  thinking: string | null
  /** Web 検索の出典（CHT-11。回答の引用元。重複は除く） */
  sources: WebSource[]
  attachments: AttachmentInfo[]
  /** ブックマークした日時（BMK-01）。null は未設定 */
  bookmarked_at: number | null
  /** 拒否されて別のモデルが回答した場合の、拒否したモデルと回答したモデル（CHT-16） */
  fallback: { from: string; to: string } | null
}

export interface WebSource {
  url: string
  title: string | null
  /** 本文で引用されたか（false は検索結果。結果を絞り込む版では引用が付かないことがある） */
  cited: boolean
}

export interface Setting {
  key: string
  value: string
  updated_at: number
}

// ========================================
// 入力型（IPC の引数にも使う）
// ========================================

export interface CreateProjectInput {
  type: ProjectType
  name: string
  custom_instructions?: string
  work_folder?: string
  model?: string
  permission_mode?: PermissionMode
}

export interface UpdateProjectInput {
  name?: string
  custom_instructions?: string
  work_folder?: string
  model?: string
  permission_mode?: PermissionMode
  pinned?: boolean
  archived?: boolean
}

export interface CreateThreadInput {
  project_id: string
  title?: string
  model?: string
  extended_thinking?: boolean
}

export interface UpdateThreadInput {
  title?: string
  model?: string
  extended_thinking?: boolean
  /** 空文字でモデルの既定に戻す */
  effort?: EffortLevel | ''
  /** 色ラベル（THR-06）。空文字で外す */
  color?: ThreadColor | ''
  /** タグ（THR-06）。指定した内容で置き換える */
  tags?: string[]
}

export interface ListProjectsOptions {
  includeArchived?: boolean
}

// ========================================
// 表示設定（要件 CMN-01、CMN-06）
// ========================================

export interface Appearance {
  mode: Mode
  accent: Accent
}

// ========================================
// 通常チャット（要件 6.4）
// ========================================

export interface SendMessageInput {
  threadId: string
  content: string
  /** 仮置き済みの添付ファイルの ID */
  attachmentIds: string[]
}

export interface EditAndResendInput {
  /** 編集する最新のユーザーメッセージ（CHT-14） */
  userMessageId: string
  content: string
  /** 元のメッセージから引き継ぐ添付ファイルの ID */
  keepAttachmentIds: string[]
  /** 新しく追加する仮置き済みの添付ファイルの ID */
  attachmentIds: string[]
}

export interface SendResult {
  userMessage: Message
  assistantMessage: Message
}

export interface StageResult {
  staged: AttachmentInfo[]
  /** 追加できなかったファイルの理由（画面にそのまま表示できる） */
  errors: string[]
}

export interface ChatPrefs {
  /** 送信キー（CHT-09: 既定は Enter。Ctrl+Enter に変更できる） */
  sendKey: 'enter' | 'ctrl_enter'
  /** 拒否されたときに別のモデルで回答し直す（CHT-16: 既定はオン） */
  fallback: boolean
}

/**
 * 生成中の応答の通知（main → renderer）
 */
export type ChatEvent =
  | { type: 'text'; threadId: string; messageId: string; text: string }
  | { type: 'thinking'; threadId: string; messageId: string; text: string }
  | {
      type: 'retrying'
      threadId: string
      messageId: string
      attempt: number
      maxAttempts: number
      waitMs: number
      message: string
    }
  | { type: 'finished'; threadId: string; message: Message; errorMessage: string | null }
  /** Cowork: ツール実行の開始・完了（COW-05） */
  | { type: 'tool'; threadId: string; messageId: string; event: ToolEventInfo }
  /** Cowork: 確認ダイアログの依頼（6.7、SEC-12） */
  | { type: 'permission'; threadId: string; request: PermissionRequest }
  /** Cowork: todo の更新（COW-13） */
  | { type: 'todos'; threadId: string; messageId: string; todos: TodoItem[] }
  /** 通常チャット: 拒否されて別のモデルが回答している（CHT-16） */
  | { type: 'fallback'; threadId: string; messageId: string; from: string; to: string }
  /** 通常チャット: Web を検索している（CHT-11） */
  | { type: 'webSearch'; threadId: string; messageId: string; query: string }
  /** スレッドのタイトルなどが更新された（THR-03 の自動生成） */
  | { type: 'threadUpdated'; threadId: string }

// ========================================
// Cowork（要件 6.5、6.7、9 章）
// ========================================

/** ツールの種別（権限判定と操作ログの絞り込みに使う） */
export type ToolCategory =
  'read' | 'write' | 'delete' | 'command' | 'plan' | 'web' | 'mcp' | 'other'

export type PermissionMethod =
  'auto' | 'allowed_once' | 'allowed_always_thread' | 'allowed_always_project' | 'denied'

/** 操作ログの 1 件（LOG-01） */
export interface ToolEventInfo {
  id: string
  thread_id: string
  message_id: string | null
  tool_use_id: string | null
  tool_name: string
  category: ToolCategory | null
  /** 対象のパス（作業フォルダからの相対パス）や検索パターン */
  target: string | null
  command: string | null
  /** 結果の要約（エラー時はエラー内容） */
  result: string | null
  permission_method: PermissionMethod
  created_at: number
  finished_at: number | null
  /** サブエージェントの実行なら、その ID（6.6） */
  agent_id: string | null
}

export interface PermissionTarget {
  /** 作業フォルダからの相対パス */
  path: string
  kind: 'file' | 'folder' | 'missing'
  size_bytes: number | null
}

/** 確認ダイアログの依頼（SEC-12: 対象の一覧を示す） */
export interface PermissionRequest {
  requestId: string
  threadId: string
  toolName: string
  category: ToolCategory
  targets: PermissionTarget[]
  command: string | null
  /** 編集内容の概要（書き込み・編集） */
  detail: string | null
  /** SEC-04 などの専用確認の理由 */
  danger: string | null
  /** 「常に許可」を選べるか（SEC-13 の多数・フォルダ削除では選べない） */
  offerAlways: boolean
}

export type PermissionResponse = 'once' | 'thread' | 'project' | 'deny'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/** 実行単位の変更（SEC-15） */
export interface FileChange {
  snapshotId: string
  /** 作業フォルダからの相対パス */
  path: string
  kind: 'modified' | 'created' | 'trashed'
  restored: boolean
}

export interface TrashEntry {
  /** .lumina-trash からの相対パス（<日時>\<元の相対パス>） */
  id: string
  /** 退避先のあるフォルダ（作業フォルダ、または読み書きの追加フォルダ。COW-12） */
  root: string
  originalPath: string
  deletedAt: number
  isFolder: boolean
  size_bytes: number
}

export interface AlwaysAllowRules {
  thread: ToolCategory[]
  project: ToolCategory[]
}

export interface UndoResult {
  restored: string[]
  skipped: { path: string; reason: string }[]
}

export interface FileDiff {
  path: string
  before: string | null
  after: string | null
  /** テキストでない・大きすぎるため内容を表示できない */
  binary: boolean
}

export interface ToolEventFilter {
  projectId?: string
  category?: ToolCategory
  /** 対象パス・コマンドの部分一致 */
  query?: string
  from?: number
  to?: number
  limit?: number
}

export interface ToolEventRow extends ToolEventInfo {
  project_id: string
  project_name: string
  thread_title: string | null
}

/** 作業フォルダのファイル（COW-08） */
export interface FileEntry {
  name: string
  /** 作業フォルダからの相対パス */
  path: string
  isDir: boolean
  /** リンク（作業フォルダ外を指すことがあるため、たどらない） */
  isLink: boolean
  size_bytes: number
  modified_at: number
}

export interface FilePreview {
  path: string
  kind: 'text' | 'image' | 'unsupported'
  text?: string
  dataUrl?: string
  size_bytes: number
  /** 大きいため先頭だけを表示している */
  truncated: boolean
}

/** 作業フォルダのスラッシュコマンド（6.6: .claude\commands\*.md） */
export interface SlashCommand {
  name: string
  description: string | null
  /** 本文（$ARGUMENTS を引数に置き換えて使う） */
  content: string
}

/** 作業フォルダのスキル（6.6: .claude\skills\<名前>\SKILL.md） */
export interface SkillInfo {
  name: string
  description: string | null
}

export interface SkillsStatus {
  skills: SkillInfo[]
  /** 現在の内容を信頼して有効にしているか（内容が変わると false に戻る） */
  trusted: boolean
}

/** MCP サーバー（6.6: プロジェクト単位で設定する） */
export type McpServer =
  | {
      name: string
      type: 'stdio'
      command: string
      args: string[]
      /** 値は暗号化して保存する。画面にはキーだけを表示する */
      env: Record<string, string>
    }
  | { name: string; type: 'http'; url: string; headers: Record<string, string> }

/** 画面に表示する MCP サーバー（秘密の値は含めない） */
export type McpServerSummary =
  | { name: string; type: 'stdio'; command: string; args: string[]; envKeys: string[] }
  | { name: string; type: 'http'; url: string; headerKeys: string[] }

export interface CoworkProjectSettings {
  /** Web 検索・Web 取得を使えるようにする（6.6: 既定はオフ） */
  webAccess: boolean
  /** 実行前に Git のスナップショットを記録する（COW-10: 既定はオフ） */
  gitSnapshots: boolean
}

/** 追加の作業フォルダ（COW-12） */
export type CoworkFolderAccess = 'read' | 'write'

export interface CoworkFolder {
  /** 実体パス（絶対パス） */
  path: string
  access: CoworkFolderAccess
}

/** Git のスナップショット（COW-10） */
export interface GitSnapshot {
  ref: string
  commit: string
  created_at: number
  message: string
}

export interface GitStatus {
  /** git コマンドが使えるか */
  available: boolean
  /** 作業フォルダが Git リポジトリの最上位か */
  repo: boolean
  enabled: boolean
  snapshots: GitSnapshot[]
}

export interface CoworkPrefs {
  /** コマンドの拒否リスト（正規表現。SEC-22） */
  denyPatterns: string[]
  /** 事前に許可するコマンド（SEC-23） */
  allowCommands: string[]
}

// ========================================
// 検索・書き出し・バックアップ（要件 6.9、6.11、10.2）
// ========================================

export interface SearchQuery {
  text: string
  projectId?: string
  projectType?: ProjectType
}

export interface SearchHit {
  /** message: 会話本文（SRC-01）/ attachment: 添付ファイル名（SRC-02） */
  kind: 'message' | 'attachment'
  message_id: string
  thread_id: string
  thread_title: string | null
  project_id: string
  project_name: string
  project_type: ProjectType
  role: MessageRole
  created_at: number
  /** 一致箇所を [ ] で囲んだ抜粋。添付ファイルの場合はファイル名 */
  snippet: string
}

/** ブックマークの一覧の 1 件（BMK-02） */
export interface BookmarkRow {
  message_id: string
  thread_id: string
  thread_title: string | null
  project_id: string
  project_name: string
  project_type: ProjectType
  /** 回答の日時 */
  created_at: number
  bookmarked_at: number
  model: string | null
  /** 回答の冒頭 */
  excerpt: string
}

/** 読み込む前の確認（EXP-01） */
export interface ImportPreview {
  /** 読み込みを確定するときに指定する */
  token: string
  name: string
  type: ProjectType
  /** 書き出し元の作業フォルダ（Cowork。EXP-05: 読み込み時に再指定する） */
  work_folder: string | null
  threads: number
  messages: number
  attachments: number
  exported_at: number
}

export interface BackupInfo {
  path: string
  created_at: number
  size_bytes: number
}

/** 全データのバックアップの概要（EXP-03。復元の前に表示する） */
export interface FullBackupPreview {
  path: string
  created_at: number
  app_version: string
  projects: number
}

// ========================================
// 使用量（要件 USG-01〜05）
// ========================================

export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  /** 概算コスト（USD） */
  cost: number
  requests: number
}

/** スレッドのコンテキスト使用量（CTX-01） */
export interface ContextUsage {
  /** 直近のリクエストで使ったトークン数（入力・キャッシュ・出力の合計）。未送信なら 0 */
  tokens: number
  /** モデルの入力上限。不明なら null */
  limit: number | null
  model: string | null
}

export interface UsageLimits {
  /** 月額上限（USD）。未設定は null（上限なし） */
  monthlyLimit: number | null
  /** 上限に達したときの動作（既定は停止。USG-04） */
  action: 'stop' | 'warn'
}

export interface UsageStatus {
  /** 対象の月（YYYY-MM） */
  month: string
  monthTotal: number
  monthlyLimit: number | null
  projectTotal: number
  projectLimit: number | null
  action: 'stop' | 'warn'
  /** 上限に対する割合の大きいほう */
  ratio: number
  level: 'ok' | 'warning' | 'exceeded'
}

export interface ProjectUsage {
  project_id: string | null
  project_name: string
  totals: UsageTotals
  limit: number | null
}

/** プロンプトキャッシュの効果（USG-07） */
export interface CacheEffect {
  /** キャッシュで節約できた概算額（USD）。書き込みの割増分を引いた額で、負になることもある */
  savedUsd: number
  /** 入力のうちキャッシュから読み込んだ割合（0〜1）。入力が無ければ null */
  hitRate: number | null
  readTokens: number
  writeTokens: number
}

export interface UsageSummary {
  month: string
  total: UsageTotals
  /** 選んだ月のキャッシュの効果（USG-07） */
  cache: CacheEffect
  months: { month: string; totals: UsageTotals }[]
  projects: ProjectUsage[]
  /** 設定されているプロジェクト別の上限（当月に使用量の無いプロジェクトを含む） */
  projectLimits: Record<string, number>
}

// ========================================
// API キー・モデル（要件 6.8）
// ========================================

export interface ApiKeyStatus {
  configured: boolean
  /** マスク表示（末尾 4 文字のみ）。未設定時は null（要件 KEY-03） */
  masked: string | null
  /** OS の暗号化（DPAPI）が利用できるか。利用できない場合は保存しない */
  encryptionAvailable: boolean
}

export interface ModelInfo {
  id: string
  display_name: string
  created_at: string
  max_input_tokens: number | null
  max_tokens: number | null
  /** adaptive thinking に対応しているか（Models API の capabilities から判定） */
  supports_adaptive_thinking: boolean
  /** 指定できる思考量（CHT-07）。空なら指定できない */
  effort_levels: EffortLevel[]
}

export interface ModelList {
  models: ModelInfo[]
  /** 一覧を取得した日時（epoch ms）。未取得なら null */
  fetched_at: number | null
  /** API から取得できず、前回のキャッシュを返している（要件 MDL-02） */
  stale: boolean
}

// ========================================
// アプリ情報・更新（要件 6.12、CMN-03、10.4）
// ========================================

/**
 * 更新の状態
 *   unconfigured  配信元が未設定（または開発版）。確認しない
 *   idle          まだ確認していない
 *   checking      確認中
 *   latest        最新版を使っている
 *   available     新しいバージョンがある（ダウンロードはユーザーの承認後）
 *   downloading   ダウンロード中
 *   downloaded    ダウンロード済み（再起動して適用するのはユーザーの承認後）
 *   error         確認・ダウンロードに失敗した
 */
export type UpdateState =
  | 'unconfigured'
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** 新しいバージョン（available・downloading・downloaded のとき） */
  version: string | null
  /** 更新内容（配信元が提供している場合。プレーンテキスト） */
  releaseNotes: string | null
  /** ダウンロードの進捗（0〜100） */
  percent: number | null
  /** 最後に確認した日時（epoch ms） */
  checkedAt: number | null
  /** error のときの内容 */
  error: string | null
}

/** オープンソースのライセンス表示（6.12） */
export interface LicenseEntry {
  name: string
  version: string
  /** SPDX 形式のライセンス名（package.json の license） */
  license: string
  /** ライセンス文（LICENSE ファイル）。見つからない場合は null */
  text: string | null
}

export interface LicenseList {
  /** アプリ本体（package.json の license。未設定なら null） */
  appLicense: string | null
  packages: LicenseEntry[]
}

/** 定型プロンプト（スニペット。CHT-12） */
export interface Snippet {
  id: string
  name: string
  content: string
}

export interface SnippetInput {
  /** 省略すると追加 */
  id?: string
  name: string
  content: string
}

/** プロジェクトのテンプレート（PRJ-09）。作業フォルダは含めない */
export interface ProjectTemplate {
  id: string
  name: string
  type: ProjectType
  custom_instructions: string | null
  model: string | null
  /** Cowork のみ */
  permission_mode: PermissionMode | null
  /** Web 検索・取得（Cowork は 6.6、通常チャットは CHT-11） */
  web_access: boolean
}
