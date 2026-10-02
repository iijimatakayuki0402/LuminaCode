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
