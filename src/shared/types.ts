/**
 * main と renderer で共有するエンティティ型（要件定義書 8 章）
 */

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

export interface Message {
  id: string
  thread_id: string
  parent_id: string | null
  role: MessageRole
  content: string
  tokens_used: number | null
  estimated_cost: number | null
  created_at: number
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
}

export interface ModelList {
  models: ModelInfo[]
  /** 一覧を取得した日時（epoch ms）。未取得なら null */
  fetched_at: number | null
  /** API から取得できず、前回のキャッシュを返している（要件 MDL-02） */
  stale: boolean
}
