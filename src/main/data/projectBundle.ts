/**
 * プロジェクトの書き出し・読み込み（要件 EXP-01、EXP-04、EXP-05）とスレッドの Markdown 書き出し（EXP-02）
 *   - 設定・スレッド・メッセージ・添付ファイル（base64）を 1 つの JSON にまとめる
 *   - API キーは含めない（DB に無い）。Cowork の作業フォルダのファイルは含めず、パスだけを保存する
 *   - 読み込みでは ID を振り直す。Cowork は作業フォルダの再指定を必須にする
 *   - Agent SDK のセッション・操作ログ・スナップショット・使用量は含めない（この PC 固有の記録のため）
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { activePath } from '@shared/conversation'
import type { ImportPreview, Project } from '@shared/types'
import { ValidationError, type MessageRecord } from '../db/operations'
import * as ops from '../db/operations'
import type { AttachmentStore } from '../chat/attachments'

export const BUNDLE_FORMAT = 'lumina-project'
export const BUNDLE_VERSION = 1

interface BundleThread {
  id: string
  title: string | null
  model: string | null
  effort: string | null
  /** 0／1。この項目が無い古いファイルはオンとして読み込む */
  extended_thinking?: number
  context_summary: string | null
  title_source: string
  active_leaf_id: string | null
  created_at: number
  updated_at: number
}

interface BundleMessage {
  id: string
  thread_id: string
  parent_id: string | null
  role: 'user' | 'assistant'
  content: string
  content_blocks: string | null
  status: string
  model: string | null
  stop_reason: string | null
  error_kind: string | null
  tokens_used: number | null
  estimated_cost: number | null
  created_at: number
}

interface BundleAttachment {
  id: string
  message_id: string
  filename: string
  mime_type: string
  size_bytes: number
  /** base64 */
  data: string
}

export interface ProjectBundle {
  format: typeof BUNDLE_FORMAT
  version: number
  exported_at: number
  project: Omit<Project, 'id'>
  threads: BundleThread[]
  messages: BundleMessage[]
  attachments: BundleAttachment[]
}

export function exportProject(
  db: Database.Database,
  attachments: AttachmentStore,
  projectId: string
): ProjectBundle {
  const project = ops.getProject(db, projectId)
  if (!project) throw new ValidationError('プロジェクトが見つかりません。')
  const { id: _id, ...projectFields } = project
  void _id
  const threads = db
    .prepare(
      `SELECT id, title, model, effort, extended_thinking, context_summary, title_source, active_leaf_id, created_at, updated_at
       FROM threads WHERE project_id = ? ORDER BY created_at, rowid`
    )
    .all(projectId) as BundleThread[]
  const messages: BundleMessage[] = []
  const files: BundleAttachment[] = []
  for (const thread of threads) {
    for (const m of ops.listMessagesByThread(db, thread.id)) {
      messages.push({
        id: m.id,
        thread_id: m.thread_id,
        parent_id: m.parent_id,
        role: m.role,
        content: m.content,
        content_blocks: m.content_blocks,
        status: m.status,
        model: m.model,
        stop_reason: m.stop_reason,
        error_kind: m.error_kind,
        tokens_used: m.tokens_used,
        estimated_cost: m.estimated_cost,
        created_at: m.created_at
      })
    }
    for (const a of ops.listAttachmentsByThread(db, thread.id)) {
      let data = ''
      try {
        data = attachments.read(a).toString('base64')
      } catch {
        continue // 保存先から失われた添付ファイルは書き出さない
      }
      files.push({
        id: a.id,
        message_id: a.message_id,
        filename: a.filename,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
        data
      })
    }
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exported_at: Date.now(),
    project: projectFields,
    threads,
    messages,
    attachments: files
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const strOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 読み込んだ JSON を検証する（形式が正しくない・新しい版のファイルは読み込まない）
 */
export function parseBundle(text: string): ProjectBundle {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ValidationError('ファイルを読み込めません（JSON の形式ではありません）。')
  }
  const fail = (): never => {
    throw new ValidationError(
      'Lumina Code のプロジェクトの書き出しファイルではないか、内容が壊れています。'
    )
  }
  if (!isObject(data) || data['format'] !== BUNDLE_FORMAT) return fail()
  if (!num(data['version']) || data['version'] > BUNDLE_VERSION) {
    throw new ValidationError(
      '新しい版の Lumina Code で書き出されたファイルのため、読み込めません。'
    )
  }
  const p = data['project']
  if (
    !isObject(p) ||
    (p['type'] !== 'chat' && p['type'] !== 'cowork') ||
    !str(p['name']) ||
    !strOrNull(p['custom_instructions'])
  ) {
    return fail()
  }
  const threads = data['threads']
  const messages = data['messages']
  const files = data['attachments']
  if (!Array.isArray(threads) || !Array.isArray(messages) || !Array.isArray(files)) return fail()
  for (const t of threads)
    if (!isObject(t) || !str(t['id']) || !strOrNull(t['title'])) return fail()
  const threadIds = new Set(threads.map((t) => (t as BundleThread).id))
  for (const m of messages) {
    if (
      !isObject(m) ||
      !str(m['id']) ||
      !str(m['thread_id']) ||
      !threadIds.has(m['thread_id']) ||
      (m['role'] !== 'user' && m['role'] !== 'assistant') ||
      !str(m['content']) ||
      !strOrNull(m['parent_id'])
    ) {
      return fail()
    }
  }
  for (const f of files) {
    if (!isObject(f) || !str(f['message_id']) || !str(f['filename']) || !str(f['data']))
      return fail()
  }
  return data as unknown as ProjectBundle
}

export function previewBundle(bundle: ProjectBundle, token: string): ImportPreview {
  return {
    token,
    name: bundle.project.name,
    type: bundle.project.type,
    work_folder: bundle.project.work_folder,
    threads: bundle.threads.length,
    messages: bundle.messages.length,
    attachments: bundle.attachments.length,
    exported_at: bundle.exported_at
  }
}

const STATUSES = new Set(['complete', 'stopped', 'error', 'interrupted'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * 読み込む（EXP-01）。ID は振り直し、Cowork の作業フォルダは呼び出し側で検証したものを使う（EXP-05）
 */
export function importBundle(
  db: Database.Database,
  attachments: AttachmentStore,
  bundle: ProjectBundle,
  workFolder: string | null
): Project {
  if (bundle.project.type === 'cowork' && !workFolder) {
    throw new ValidationError('Cowork のプロジェクトは、作業フォルダを指定して読み込んでください。')
  }
  const newId = new Map<string, string>()
  const idFor = (old: string): string => {
    let id = newId.get(old)
    if (!id) {
      id = randomUUID()
      newId.set(old, id)
    }
    return id
  }

  return db.transaction(() => {
    const p = bundle.project
    const project = ops.createProject(db, {
      type: p.type,
      name: p.name,
      ...(p.custom_instructions ? { custom_instructions: p.custom_instructions } : {}),
      ...(p.type === 'cowork' && workFolder ? { work_folder: workFolder } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.permission_mode ? { permission_mode: p.permission_mode } : {})
    })

    const insertThread = db.prepare(
      `INSERT INTO threads (id, project_id, title, model, effort, context_summary, title_source,
         extended_thinking, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
    )
    for (const t of bundle.threads) {
      insertThread.run(
        idFor(t.id),
        project.id,
        t.title,
        t.model ?? null,
        t.effort && EFFORTS.has(t.effort) ? t.effort : null,
        t.context_summary ?? null,
        t.extended_thinking === 0 ? 0 : 1,
        num(t.created_at) ? t.created_at : Date.now(),
        num(t.updated_at) ? t.updated_at : Date.now()
      )
    }

    const insertMessage = db.prepare(
      `INSERT INTO messages (id, thread_id, parent_id, role, content, content_blocks, status, model,
         stop_reason, error_kind, tokens_used, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const known = new Set(bundle.messages.map((m) => m.id))
    for (const m of bundle.messages) {
      insertMessage.run(
        idFor(m.id),
        idFor(m.thread_id),
        m.parent_id && known.has(m.parent_id) ? idFor(m.parent_id) : null,
        m.role,
        m.content,
        typeof m.content_blocks === 'string' ? m.content_blocks : null,
        // 生成中のまま書き出されたものは中断として扱う
        STATUSES.has(m.status) ? m.status : 'interrupted',
        m.model ?? null,
        m.stop_reason ?? null,
        null,
        num(m.tokens_used) ? m.tokens_used : null,
        num(m.estimated_cost) ? m.estimated_cost : null,
        num(m.created_at) ? m.created_at : Date.now()
      )
    }

    for (const t of bundle.threads) {
      if (t.active_leaf_id && known.has(t.active_leaf_id)) {
        db.prepare('UPDATE threads SET active_leaf_id = ? WHERE id = ?').run(
          idFor(t.active_leaf_id),
          idFor(t.id)
        )
      }
    }

    for (const f of bundle.attachments) {
      if (!known.has(f.message_id)) continue
      try {
        const record = attachments.writeFor(
          idFor(f.message_id),
          f.filename,
          f.mime_type,
          Buffer.from(f.data, 'base64')
        )
        ops.insertAttachment(db, record)
      } catch (error) {
        // 対応外の形式・大きすぎるものは読み込まない（会話本文は残る）
        console.warn('[import] skipped attachment:', (error as Error).message)
      }
    }
    return ops.getProject(db, project.id)!
  })()
}

const formatTime = (epoch: number): string =>
  new Date(epoch).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' })

/**
 * スレッドを Markdown にする（EXP-02: 表示中の分岐を書き出す）
 */
export function threadToMarkdown(db: Database.Database, threadId: string): string {
  const thread = ops.getThread(db, threadId)
  if (!thread) throw new ValidationError('スレッドが見つかりません。')
  const project = ops.getProject(db, thread.project_id)!
  const records: MessageRecord[] = ops.listMessagesByThread(db, threadId)
  const path = activePath(records, thread.active_leaf_id)
  const files = new Map<string, string[]>()
  for (const a of ops.listAttachmentsByThread(db, threadId)) {
    files.set(a.message_id, [...(files.get(a.message_id) ?? []), a.filename])
  }
  const lines = [
    `# ${thread.title ?? '無題のスレッド'}`,
    '',
    `- プロジェクト: ${project.name}`,
    `- 書き出し日時: ${formatTime(Date.now())}`,
    ''
  ]
  for (const m of path) {
    const head = m.role === 'user' ? 'USER' : `CLAUDE${m.model ? `（${m.model}）` : ''}`
    lines.push(`## ${head} — ${formatTime(m.created_at)}`, '')
    const attached = files.get(m.id)
    if (attached?.length) lines.push(`添付: ${attached.join(', ')}`, '')
    lines.push(m.content || '（内容なし）', '')
  }
  return lines.join('\n')
}
