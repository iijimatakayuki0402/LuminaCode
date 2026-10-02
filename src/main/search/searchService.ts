/**
 * 横断検索（要件 SRC-01: 会話本文、SRC-02: 添付ファイル名、DSH-09）
 * 3 文字以上は全文検索（trigram）、それより短い語は部分一致（LIKE）で探す。
 */

import type Database from 'better-sqlite3'
import type { SearchHit, SearchQuery } from '@shared/types'

export const SEARCH_LIMIT = 100
const SNIPPET_CHARS = 40

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/** FTS5 の検索式として安全な形にする（語ごとに引用符で囲み、すべて含むものを探す） */
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ')
}

/** 一致した位置の前後を切り出す（LIKE で探した場合の抜粋） */
function snippetOf(content: string, term: string): string {
  const index = content.toLowerCase().indexOf(term.toLowerCase())
  if (index < 0) return content.slice(0, SNIPPET_CHARS * 2)
  const start = Math.max(0, index - SNIPPET_CHARS)
  const end = Math.min(content.length, index + term.length + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${content.slice(start, index)}[${content.slice(index, index + term.length)}]${content.slice(index + term.length, end)}${end < content.length ? '…' : ''}`
}

interface Row {
  message_id: string
  thread_id: string
  thread_title: string | null
  project_id: string
  project_name: string
  project_type: 'chat' | 'cowork'
  role: 'user' | 'assistant'
  created_at: number
  snippet?: string
  content?: string
  filename?: string
}

export function search(db: Database.Database, query: SearchQuery): SearchHit[] {
  const text = query.text.trim()
  if (!text) return []
  const terms = text.split(/\s+/).filter(Boolean)
  const filters: string[] = []
  const params: (string | number)[] = []
  if (query.projectId) {
    filters.push('t.project_id = ?')
    params.push(query.projectId)
  }
  if (query.projectType) {
    filters.push('p.type = ?')
    params.push(query.projectType)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  const common = `m.id AS message_id, m.thread_id, t.title AS thread_title, t.project_id,
    p.name AS project_name, p.type AS project_type, m.role, m.created_at`

  // 会話本文（SRC-01）
  let messages: Row[]
  if (terms.every((t) => [...t].length >= 3)) {
    messages = db
      .prepare(
        `SELECT ${common}, snippet(messages_fts, 0, '[', ']', '…', 40) AS snippet
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN threads t ON t.id = m.thread_id
         JOIN projects p ON p.id = t.project_id
         WHERE messages_fts MATCH ? ${where}
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(ftsQuery(text), ...params, SEARCH_LIMIT) as Row[]
  } else {
    const likes = terms.map(() => "m.content LIKE ? ESCAPE '\\'").join(' AND ')
    messages = (
      db
        .prepare(
          `SELECT ${common}, m.content
           FROM messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN projects p ON p.id = t.project_id
           WHERE ${likes} ${where}
           ORDER BY m.created_at DESC LIMIT ?`
        )
        .all(...terms.map((t) => `%${likeEscape(t)}%`), ...params, SEARCH_LIMIT) as Row[]
    ).map((r) => ({ ...r, snippet: snippetOf(r.content ?? '', terms[0]) }))
  }

  // 添付ファイル名（SRC-02）
  const files = db
    .prepare(
      `SELECT ${common}, a.filename
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN threads t ON t.id = m.thread_id
       JOIN projects p ON p.id = t.project_id
       WHERE a.filename LIKE ? ESCAPE '\\' ${where}
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(`%${likeEscape(text)}%`, ...params, SEARCH_LIMIT) as Row[]

  const toHit = (r: Row, kind: SearchHit['kind']): SearchHit => ({
    kind,
    message_id: r.message_id,
    thread_id: r.thread_id,
    thread_title: r.thread_title,
    project_id: r.project_id,
    project_name: r.project_name,
    project_type: r.project_type,
    role: r.role,
    created_at: r.created_at,
    snippet: kind === 'attachment' ? (r.filename ?? '') : (r.snippet ?? '')
  })
  return [...files.map((r) => toHit(r, 'attachment')), ...messages.map((r) => toHit(r, 'message'))]
}
