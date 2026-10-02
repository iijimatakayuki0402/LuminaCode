/**
 * main と renderer で共有するエンティティ型（要件定義書 8 章）
 */

import type { Accent, Mode } from './theme'

export type ProjectType = 'chat' | 'cowork'
export type PermissionMode = 'confirm_each' | 'auto_edit' | 'plan_only'
export type MessageRole = 'user' | 'assistant'

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

export interface Thread {
  id: string
  project_id: string
  title: string | null
  model: string | null
  extended_thinking: boolean
  last_opened_at: number | null
  created_at: number
  updated_at: number
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
  attachments: AttachmentInfo[]
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
}

export interface ModelList {
  models: ModelInfo[]
  /** 一覧を取得した日時（epoch ms）。未取得なら null */
  fetched_at: number | null
  /** API から取得できず、前回のキャッシュを返している（要件 MDL-02） */
  stale: boolean
}
