/**
 * データベース操作
 * CRUD操作を提供
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ApiErrorKind,
  EffortLevel,
  CreateProjectInput,
  CreateThreadInput,
  MessageRole,
  MessageStatus,
  PermissionMode,
  Project,
  ProjectType,
  Thread,
  UpdateProjectInput,
  UpdateThreadInput
} from '@shared/types'

// ========================================
// 型定義
// ========================================

// SQLiteの行型定義（列挙値は CHECK 制約で保証される）
interface ProjectRow {
  id: string
  type: ProjectType
  name: string
  custom_instructions: string | null
  work_folder: string | null
  model: string | null
  permission_mode: PermissionMode
  pinned: number
  archived: number
  created_at: number
  updated_at: number
}

interface ThreadRow {
  id: string
  project_id: string
  title: string | null
  model: string | null
  extended_thinking: number
  last_opened_at: number | null
  created_at: number
  updated_at: number
  active_leaf_id: string | null
  effort: EffortLevel | null
  context_summary: string | null
  title_source: 'auto' | 'ai' | 'manual'
}

/**
 * messages テーブルの行（content_blocks は main 内でのみ使い、renderer には渡さない）
 */
export interface MessageRecord {
  id: string
  thread_id: string
  parent_id: string | null
  role: MessageRole
  content: string
  tokens_used: number | null
  estimated_cost: number | null
  created_at: number
  status: MessageStatus
  content_blocks: string | null
  model: string | null
  stop_reason: string | null
  error_kind: ApiErrorKind | null
  /** Cowork: Agent SDK のセッション内の位置（編集・再実行で巻き戻す） */
  agent_resume_uuid?: string | null
  /** Cowork: 実行終了時点の Agent SDK の累計（JSON） */
  agent_usage_total?: string | null
}

export interface AttachmentRecord {
  id: string
  message_id: string
  filename: string
  stored_path: string
  mime_type: string
  size_bytes: number
  created_at: number
}

// ========================================
// 行 → エンティティ変換
// ========================================

function toProject(row: ProjectRow): Project {
  return {
    ...row,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived)
  }
}

function toThread(row: ThreadRow): Thread {
  return {
    ...row,
    extended_thinking: Boolean(row.extended_thinking)
  }
}

// ========================================
// 入力検証
// ========================================

/**
 * 入力値が要件を満たさない場合のエラー（message は画面にそのまま表示できる文言）
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export const PROJECT_NAME_MAX_LENGTH = 100
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 20000

// SQLite の length() と同じく文字（コードポイント）単位で数える
const charLength = (value: string): number => [...value].length

/**
 * プロジェクトの入力検証（要件 6.2、PRJ-02、PRJ-03）
 */
function validateProject(project: {
  type: ProjectType
  name: string
  custom_instructions: string | null
  work_folder: string | null
}): void {
  if (project.name.trim() === '') {
    throw new ValidationError('プロジェクト名を入力してください。')
  }
  if (charLength(project.name) > PROJECT_NAME_MAX_LENGTH) {
    throw new ValidationError(
      `プロジェクト名は ${PROJECT_NAME_MAX_LENGTH} 文字以内で入力してください。`
    )
  }
  if (
    project.custom_instructions !== null &&
    charLength(project.custom_instructions) > CUSTOM_INSTRUCTIONS_MAX_LENGTH
  ) {
    throw new ValidationError(
      `カスタム指示は ${CUSTOM_INSTRUCTIONS_MAX_LENGTH.toLocaleString()} 文字以内で入力してください。`
    )
  }
  if (project.type === 'cowork' && project.work_folder === null) {
    throw new ValidationError('Cowork プロジェクトには作業フォルダを指定してください。')
  }
  if (project.type === 'chat' && project.work_folder !== null) {
    throw new ValidationError('通常チャットのプロジェクトには作業フォルダを指定できません。')
  }
}

// ========================================
// Project操作
// ========================================

export function createProject(db: Database.Database, input: CreateProjectInput): Project {
  const now = Date.now()
  const id = randomUUID()
  const customInstructions = input.custom_instructions || null
  const workFolder = input.work_folder || null

  validateProject({
    type: input.type,
    name: input.name,
    custom_instructions: customInstructions,
    work_folder: workFolder
  })

  const stmt = db.prepare(`
    INSERT INTO projects (
      id, type, name, custom_instructions, work_folder, model, permission_mode,
      pinned, archived, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `)

  stmt.run(
    id,
    input.type,
    input.name,
    customInstructions,
    workFolder,
    input.model || null,
    input.permission_mode ?? 'confirm_each',
    now,
    now
  )

  return getProject(db, id)!
}

export function getProject(db: Database.Database, id: string): Project | null {
  const stmt = db.prepare('SELECT * FROM projects WHERE id = ?')
  const row = stmt.get(id) as ProjectRow | undefined

  return row ? toProject(row) : null
}

export function updateProject(
  db: Database.Database,
  id: string,
  input: UpdateProjectInput
): Project | null {
  const current = getProject(db, id)
  if (!current) return null

  validateProject({
    type: current.type,
    name: input.name ?? current.name,
    custom_instructions:
      input.custom_instructions !== undefined
        ? input.custom_instructions || null
        : current.custom_instructions,
    work_folder: input.work_folder !== undefined ? input.work_folder || null : current.work_folder
  })

  const now = Date.now()
  const updates: string[] = []
  const values: (string | number | null)[] = []

  if (input.name !== undefined) {
    updates.push('name = ?')
    values.push(input.name)
  }
  if (input.custom_instructions !== undefined) {
    updates.push('custom_instructions = ?')
    values.push(input.custom_instructions || null)
  }
  if (input.work_folder !== undefined) {
    updates.push('work_folder = ?')
    values.push(input.work_folder || null)
  }
  if (input.model !== undefined) {
    updates.push('model = ?')
    values.push(input.model || null)
  }
  if (input.permission_mode !== undefined) {
    updates.push('permission_mode = ?')
    values.push(input.permission_mode)
  }
  if (input.pinned !== undefined) {
    updates.push('pinned = ?')
    values.push(input.pinned ? 1 : 0)
  }
  if (input.archived !== undefined) {
    updates.push('archived = ?')
    values.push(input.archived ? 1 : 0)
  }

  if (updates.length === 0) return current

  updates.push('updated_at = ?')
  values.push(now)
  values.push(id)

  const stmt = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`)
  stmt.run(...values)

  return getProject(db, id)
}

export function deleteProject(db: Database.Database, id: string): boolean {
  const stmt = db.prepare('DELETE FROM projects WHERE id = ?')
  const result = stmt.run(id)
  return result.changes > 0
}

/**
 * プロジェクト一覧（ピン留め優先、更新日時の新しい順）
 * アーカイブ済みは既定で含めない（要件 DSH-07）
 */
export function listProjects(
  db: Database.Database,
  options: { includeArchived?: boolean } = {}
): Project[] {
  const stmt = db.prepare(`
    SELECT * FROM projects
    ${options.includeArchived ? '' : 'WHERE archived = 0'}
    ORDER BY pinned DESC, updated_at DESC
  `)
  const rows = stmt.all() as ProjectRow[]

  return rows.map(toProject)
}

// ========================================
// Thread操作
// ========================================

export function createThread(db: Database.Database, input: CreateThreadInput): Thread {
  const now = Date.now()
  const id = randomUUID()

  const stmt = db.prepare(`
    INSERT INTO threads (
      id, project_id, title, model, extended_thinking, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    id,
    input.project_id,
    input.title ?? null,
    input.model ?? null,
    // CHT-07: 既定はオン
    input.extended_thinking === false ? 0 : 1,
    now,
    now
  )

  return getThread(db, id)!
}

export function getThread(db: Database.Database, id: string): Thread | null {
  const stmt = db.prepare('SELECT * FROM threads WHERE id = ?')
  const row = stmt.get(id) as ThreadRow | undefined

  return row ? toThread(row) : null
}

/** main 内部での更新（タイトルの由来・分岐の末端・要約を含む） */
export interface UpdateThreadFields extends Omit<UpdateThreadInput, 'effort'> {
  effort?: EffortLevel | '' | null
  title_source?: 'auto' | 'ai' | 'manual'
  active_leaf_id?: string | null
  context_summary?: string | null
}

export function updateThread(
  db: Database.Database,
  id: string,
  input: UpdateThreadFields
): Thread | null {
  const current = getThread(db, id)
  if (!current) return null

  const updates: string[] = []
  const values: (string | number | null)[] = []
  const set = (column: string, value: string | number | null): void => {
    updates.push(`${column} = ?`)
    values.push(value)
  }

  if (input.title !== undefined) set('title', input.title || null)
  if (input.model !== undefined) set('model', input.model || null)
  if (input.extended_thinking !== undefined)
    set('extended_thinking', input.extended_thinking ? 1 : 0)
  if (input.effort !== undefined) set('effort', input.effort || null)
  if (input.title_source !== undefined) set('title_source', input.title_source)
  if (input.context_summary !== undefined) set('context_summary', input.context_summary)

  // 表示中の分岐の切り替えは、スレッドの更新日時（一覧の並び順）を変えない
  if (input.active_leaf_id !== undefined) {
    db.prepare('UPDATE threads SET active_leaf_id = ? WHERE id = ?').run(input.active_leaf_id, id)
  }
  if (updates.length === 0) return getThread(db, id)

  set('updated_at', Date.now())
  values.push(id)
  db.prepare(`UPDATE threads SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  return getThread(db, id)
}

export function deleteThread(db: Database.Database, id: string): boolean {
  const stmt = db.prepare('DELETE FROM threads WHERE id = ?')
  const result = stmt.run(id)
  return result.changes > 0
}

export function listThreadsByProject(db: Database.Database, projectId: string): Thread[] {
  const stmt = db.prepare(`
    SELECT * FROM threads
    WHERE project_id = ?
    ORDER BY updated_at DESC
  `)
  const rows = stmt.all(projectId) as ThreadRow[]

  return rows.map(toThread)
}

/**
 * スレッドを開いた日時を記録する（要件 THR-05）
 * 一覧の並び順（updated_at）には影響させない
 */
export function markThreadOpened(db: Database.Database, id: string): boolean {
  const stmt = db.prepare('UPDATE threads SET last_opened_at = ? WHERE id = ?')
  return stmt.run(Date.now(), id).changes > 0
}

/**
 * プロジェクト内で最後に開いたスレッドを取得する（要件 THR-05）
 */
export function getLastOpenedThread(db: Database.Database, projectId: string): Thread | null {
  const stmt = db.prepare(`
    SELECT * FROM threads
    WHERE project_id = ? AND last_opened_at IS NOT NULL
    ORDER BY last_opened_at DESC
    LIMIT 1
  `)
  const row = stmt.get(projectId) as ThreadRow | undefined
  return row ? toThread(row) : null
}

// ========================================
// Message操作
// ========================================

export interface CreateMessageInput {
  thread_id: string
  parent_id?: string | null
  role: MessageRole
  content: string
  tokens_used?: number
  estimated_cost?: number
  status?: MessageStatus
  model?: string | null
}

export function createMessage(db: Database.Database, input: CreateMessageInput): MessageRecord {
  const now = Date.now()
  const id = randomUUID()

  // メッセージ追加とスレッド・プロジェクトの更新日時の反映を 1 つのトランザクションで行う
  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO messages (
        id, thread_id, parent_id, role, content, tokens_used, estimated_cost, created_at,
        status, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      input.thread_id,
      input.parent_id ?? null,
      input.role,
      input.content,
      input.tokens_used ?? null,
      input.estimated_cost ?? null,
      now,
      input.status ?? 'complete',
      input.model ?? null
    )

    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, input.thread_id)
    db.prepare(
      'UPDATE projects SET updated_at = ? WHERE id = (SELECT project_id FROM threads WHERE id = ?)'
    ).run(now, input.thread_id)
  })()

  return getMessage(db, id)!
}

export function getMessage(db: Database.Database, id: string): MessageRecord | null {
  const stmt = db.prepare('SELECT * FROM messages WHERE id = ?')
  const row = stmt.get(id) as MessageRecord | undefined
  return row ?? null
}

export function listMessagesByThread(db: Database.Database, threadId: string): MessageRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE thread_id = ?
    ORDER BY created_at ASC, rowid ASC
  `)
  return stmt.all(threadId) as MessageRecord[]
}

export interface UpdateMessageInput {
  content?: string
  status?: MessageStatus
  content_blocks?: string | null
  stop_reason?: string | null
  error_kind?: ApiErrorKind | null
  tokens_used?: number | null
  estimated_cost?: number | null
}

const UPDATABLE_MESSAGE_COLUMNS: (keyof UpdateMessageInput)[] = [
  'content',
  'status',
  'content_blocks',
  'stop_reason',
  'error_kind',
  'tokens_used',
  'estimated_cost'
]

/**
 * 応答の内容・状態を更新する（ストリーミングの完了・停止・エラー時）
 */
export function updateMessage(db: Database.Database, id: string, input: UpdateMessageInput): void {
  const columns = UPDATABLE_MESSAGE_COLUMNS.filter((c) => input[c] !== undefined)
  if (columns.length === 0) return
  db.prepare(`UPDATE messages SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...columns.map((c) => input[c] ?? null),
    id
  )
}

/**
 * 生成中のまま残った応答を「中断」にする（要件 6.14: 異常終了後の再起動時）
 */
export function markStreamingInterrupted(db: Database.Database): number {
  return db.prepare("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'").run()
    .changes
}

// ========================================
// Attachment操作（要件 ATT-04）
// ========================================

export function insertAttachment(
  db: Database.Database,
  input: Omit<AttachmentRecord, 'created_at'>
): AttachmentRecord {
  const record = { ...input, created_at: Date.now() }
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, stored_path, mime_type, size_bytes, created_at)
     VALUES (@id, @message_id, @filename, @stored_path, @mime_type, @size_bytes, @created_at)`
  ).run(record)
  return record
}

export function listAttachmentsByThread(
  db: Database.Database,
  threadId: string
): AttachmentRecord[] {
  return db
    .prepare(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.thread_id = ? ORDER BY a.created_at ASC, a.rowid ASC`
    )
    .all(threadId) as AttachmentRecord[]
}

// ========================================
// UsageRecord操作（要件 USG）
// ========================================

export interface UsageInput {
  project_id: string
  project_name: string
  thread_id: string
  /** 応答に紐付かない使用量（タイトル生成・要約）は null */
  message_id: string | null
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  estimated_cost: number
}

export function insertUsageRecord(db: Database.Database, input: UsageInput): void {
  db.prepare(
    `INSERT INTO usage_records (
       id, project_id, project_name, thread_id, message_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, estimated_cost, created_at
     ) VALUES (
       @id, @project_id, @project_name, @thread_id, @message_id, @model, @input_tokens,
       @output_tokens, @cache_read_tokens, @cache_write_tokens, @estimated_cost, @created_at
     )`
  ).run({ ...input, id: randomUUID(), created_at: Date.now() })
}

// ========================================
// Settings操作
// ========================================

export function getSetting(db: Database.Database, key: string): string | null {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?')
  const row = stmt.get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  const now = Date.now()

  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
  `)

  stmt.run(key, value, now, value, now)
}

export function deleteSetting(db: Database.Database, key: string): boolean {
  const stmt = db.prepare('DELETE FROM settings WHERE key = ?')
  const result = stmt.run(key)
  return result.changes > 0
}
