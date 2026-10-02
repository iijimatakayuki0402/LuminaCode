/**
 * 操作ログ（要件 LOG-01〜03、SEC-25）
 * Cowork のすべてのツール実行（読み取り・書き込み・削除・コマンド・拒否）を、日時・対象・結果・許可方法つきで記録する。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { PermissionMethod, ToolCategory, ToolEventInfo } from '@shared/types'

/** 結果の要約の最大長（出力の全文は残さない） */
export const RESULT_SUMMARY_LENGTH = 2000

/** ログの保持期間（LOG-03） */
export const LOG_RETENTION_DAYS = 90

export function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > RESULT_SUMMARY_LENGTH ? `${text.slice(0, RESULT_SUMMARY_LENGTH)}…` : text
}

/**
 * ツールの実行結果を、操作ログで読める形に要約する（SEC-25: コマンドは出力の要約を残す）
 */
export function summarizeToolResponse(toolName: string, response: unknown): string {
  if (typeof response === 'string') return response
  // MCP ツール（削除ツールなど）: 本文だけを取り出す
  if (Array.isArray(response)) {
    const texts = response
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join('\n')
  }
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>
    // コマンド: 出力（標準出力・標準エラー）
    if ('stdout' in r || 'stderr' in r) {
      const out = [r['stdout'], r['stderr']]
        .filter((v) => typeof v === 'string' && v.trim())
        .join('\n')
      return r['interrupted'] ? `（中断）${out}` : out || '（出力なし）'
    }
    // ファイル操作: 作成・更新・読み取りの完了だけを記録する（内容は残さない）
    if (['Write', 'Edit', 'NotebookEdit', 'Read'].includes(toolName)) {
      return typeof r['type'] === 'string' ? `完了（${r['type']}）` : '完了'
    }
  }
  return JSON.stringify(response ?? null)
}

export function insertToolEvent(
  db: Database.Database,
  input: {
    threadId: string
    messageId: string | null
    toolUseId: string | null
    toolName: string
    category: ToolCategory
    target: string | null
    command: string | null
    method: PermissionMethod
    /** 拒否した場合は理由をそのまま結果にする */
    result?: string | null
    /** サブエージェントの実行なら、その ID */
    agentId?: string | null
  }
): ToolEventInfo {
  const event: ToolEventInfo = {
    id: randomUUID(),
    thread_id: input.threadId,
    message_id: input.messageId,
    tool_use_id: input.toolUseId,
    tool_name: input.toolName,
    category: input.category,
    target: input.target,
    command: input.command,
    result: input.result ?? null,
    permission_method: input.method,
    created_at: Date.now(),
    finished_at: input.method === 'denied' ? Date.now() : null,
    agent_id: input.agentId ?? null
  }
  db.prepare(
    `INSERT INTO tool_events (id, thread_id, message_id, tool_use_id, tool_name, category, target,
       command, result, permission_method, created_at, finished_at, agent_id)
     VALUES (@id, @thread_id, @message_id, @tool_use_id, @tool_name, @category, @target, @command,
       @result, @permission_method, @created_at, @finished_at, @agent_id)`
  ).run(event)
  return event
}

/** ツールの実行結果を記録する（PostToolUse） */
export function finishToolEvent(
  db: Database.Database,
  toolUseId: string,
  result: string
): ToolEventInfo | null {
  db.prepare(
    `UPDATE tool_events SET result = ?, finished_at = ?
     WHERE tool_use_id = ? AND finished_at IS NULL`
  ).run(summarize(result), Date.now(), toolUseId)
  return (
    (db.prepare('SELECT * FROM tool_events WHERE tool_use_id = ?').get(toolUseId) as
      ToolEventInfo | undefined) ?? null
  )
}

export function listToolEventsByThread(db: Database.Database, threadId: string): ToolEventInfo[] {
  return db
    .prepare('SELECT * FROM tool_events WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(threadId) as ToolEventInfo[]
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

/**
 * 操作ログの検索（LOG-02: 日時・種別・対象で絞り込む）
 */
export function searchToolEvents(db: Database.Database, filter: ToolEventFilter): ToolEventRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.projectId) {
    where.push('t.project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.category) {
    where.push('e.category = ?')
    params.push(filter.category)
  }
  if (filter.query) {
    where.push("(e.target LIKE ? ESCAPE '\\' OR e.command LIKE ? ESCAPE '\\')")
    const like = `%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    params.push(like, like)
  }
  if (filter.from !== undefined) {
    where.push('e.created_at >= ?')
    params.push(filter.from)
  }
  if (filter.to !== undefined) {
    where.push('e.created_at <= ?')
    params.push(filter.to)
  }
  return db
    .prepare(
      `SELECT e.*, t.project_id, p.name AS project_name, t.title AS thread_title
       FROM tool_events e
       JOIN threads t ON t.id = e.thread_id
       JOIN projects p ON p.id = t.project_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.created_at DESC, e.rowid DESC
       LIMIT ?`
    )
    .all(...params, filter.limit ?? 1000) as ToolEventRow[]
}

/** 保持期間を過ぎたログ、または指定日時より前のログを削除する（LOG-03） */
export function deleteToolEventsBefore(db: Database.Database, before: number): number {
  return db.prepare('DELETE FROM tool_events WHERE created_at < ?').run(before).changes
}

const CSV_COLUMNS: (keyof ToolEventRow)[] = [
  'created_at',
  'project_name',
  'thread_title',
  'tool_name',
  'category',
  'target',
  'command',
  'permission_method',
  'result'
]

const csvCell = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'number' && value > 1e12
        ? new Date(value).toISOString()
        : String(value)
  // 表計算ソフトで数式として解釈されないようにする
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** 操作ログの書き出し（LOG-02）。CSV は Excel で開けるよう BOM を付ける */
export function formatToolEvents(rows: ToolEventRow[], format: 'csv' | 'json'): string {
  if (format === 'json') return JSON.stringify(rows, null, 2)
  const lines = [
    CSV_COLUMNS.join(','),
    ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))
  ]
  return `\ufeff${lines.join('\r\n')}\r\n`
}
