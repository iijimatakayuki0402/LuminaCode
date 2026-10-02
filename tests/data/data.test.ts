import type Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activePath } from '../../src/shared/conversation'
import { AttachmentStore } from '../../src/main/chat/attachments'
import {
  BACKUP_GENERATIONS,
  backupNow,
  listBackups,
  runDailyBackup
} from '../../src/main/data/backup'
import {
  BUNDLE_VERSION,
  exportProject,
  importBundle,
  parseBundle,
  threadToMarkdown
} from '../../src/main/data/projectBundle'
import { createInMemoryDatabase, openDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { ftsQuery, search } from '../../src/main/search/searchService'

let db: Database.Database
let dir: string
let attachments: AttachmentStore

beforeEach(() => {
  db = createInMemoryDatabase()
  dir = mkdtempSync(join(tmpdir(), 'lumina-data-'))
  attachments = new AttachmentStore(join(dir, 'attachments'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function seed(): { projectId: string; threadId: string } {
  const project = ops.createProject(db, {
    type: 'chat',
    name: '旅行',
    custom_instructions: '丁寧に'
  })
  const thread = ops.createThread(db, { project_id: project.id, title: '京都' })
  const q = ops.createMessage(db, {
    thread_id: thread.id,
    role: 'user',
    content: '京都の紅葉の名所を教えて'
  })
  const a = ops.createMessage(db, {
    thread_id: thread.id,
    parent_id: q.id,
    role: 'assistant',
    content: '嵐山や東福寺が有名です。'
  })
  // 分岐（編集した版）
  const q2 = ops.createMessage(db, {
    thread_id: thread.id,
    role: 'user',
    content: '奈良の紅葉は？'
  })
  ops.updateThread(db, thread.id, { active_leaf_id: a.id })
  void q2
  const staged = attachments.stageFromData('memo.txt', Buffer.from('しおり'))
  for (const r of attachments.commit(q.id, [staged.id])) ops.insertAttachment(db, r)
  return { projectId: project.id, threadId: thread.id }
}

describe('横断検索（SRC-01、SRC-02）', () => {
  it('3 文字以上は全文検索で、抜粋に一致箇所を示す', () => {
    seed()
    const hits = search(db, { text: '紅葉の名所' })
    expect(hits.map((h) => [h.kind, h.role])).toEqual([['message', 'user']])
    expect(hits[0].snippet).toContain('[紅葉の名所]')
    expect(hits[0]).toMatchObject({ project_name: '旅行', thread_title: '京都' })
  })

  it('2 文字以下でも部分一致で探せる。複数語はすべてを含むもの', () => {
    seed()
    expect(search(db, { text: '嵐山' }).map((h) => h.role)).toEqual(['assistant'])
    expect(search(db, { text: '紅葉 奈良' }).map((h) => h.snippet)).toEqual([
      expect.stringContaining('奈良')
    ])
  })

  it('添付ファイル名で探せる', () => {
    seed()
    expect(search(db, { text: 'memo' })).toMatchObject([
      { kind: 'attachment', snippet: 'memo.txt' }
    ])
  })

  it('プロジェクト・種別で絞り込め、編集・削除が索引に反映される', () => {
    const { threadId } = seed()
    expect(search(db, { text: '紅葉の名所', projectType: 'cowork' })).toEqual([])
    const m = ops.listMessagesByThread(db, threadId)[1]
    ops.updateMessage(db, m.id, { content: '金閣寺も人気です' })
    expect(search(db, { text: '嵐山や東福寺' })).toEqual([])
    expect(search(db, { text: '金閣寺も' })).toHaveLength(1)
    ops.deleteThread(db, threadId)
    expect(search(db, { text: '金閣寺も' })).toEqual([])
  })

  it('記号や検索式の文字を含んでも壊れない', () => {
    seed()
    expect(() => search(db, { text: '"OR" NEAR( * - ' })).not.toThrow()
    expect(search(db, { text: '%_' })).toEqual([])
    expect(ftsQuery('a "b" c')).toBe('"a" AND """b""" AND "c"')
  })
})

describe('書き出し・読み込み（EXP-01、EXP-04、EXP-05）', () => {
  it('新しい ID で復元し、分岐・表示中の版・添付ファイルを保つ', () => {
    const { projectId } = seed()
    const bundle = parseBundle(JSON.stringify(exportProject(db, attachments, projectId)))
    expect(JSON.stringify(bundle)).not.toMatch(/sk-ant/)

    const imported = importBundle(db, attachments, bundle, null)
    expect(imported).toMatchObject({ name: '旅行', custom_instructions: '丁寧に', type: 'chat' })
    const [thread] = ops.listThreadsByProject(db, imported.id)
    const records = ops.listMessagesByThread(db, thread.id)
    expect(records).toHaveLength(3)
    expect(records.every((r) => !bundle.messages.some((m) => m.id === r.id))).toBe(true)
    expect(activePath(records, thread.active_leaf_id).map((m) => m.content)).toEqual([
      '京都の紅葉の名所を教えて',
      '嵐山や東福寺が有名です。'
    ])
    const [file] = ops.listAttachmentsByThread(db, thread.id)
    expect(attachments.read(file).toString()).toBe('しおり')
  })

  it('Cowork は作業フォルダを再指定しないと読み込めない', () => {
    const project = ops.createProject(db, { type: 'cowork', name: 'C', work_folder: dir })
    const bundle = exportProject(db, attachments, project.id)
    expect(bundle.project.work_folder).toBe(dir)
    expect(() => importBundle(db, attachments, bundle, null)).toThrow('作業フォルダ')
    expect(importBundle(db, attachments, bundle, join(dir, 'new')).work_folder).toBe(
      join(dir, 'new')
    )
  })

  it('添付ファイルの形式はファイル名から判定し直し、対応外は読み込まない', () => {
    const { projectId } = seed()
    const bundle = exportProject(db, attachments, projectId)
    bundle.attachments[0].mime_type = 'image/svg+xml'
    bundle.attachments.push({ ...bundle.attachments[0], id: 'x', filename: 'evil.exe' })
    const imported = importBundle(db, attachments, bundle, null)
    const [thread] = ops.listThreadsByProject(db, imported.id)
    expect(
      ops.listAttachmentsByThread(db, thread.id).map((a) => [a.filename, a.mime_type])
    ).toEqual([['memo.txt', 'text/plain']])
  })

  it('形式の違うファイル・新しい版のファイルは拒否する', () => {
    expect(() => parseBundle('not json')).toThrow('JSON')
    expect(() => parseBundle('{"format":"x"}')).toThrow('書き出しファイルではない')
    const { projectId } = seed()
    const bundle = exportProject(db, attachments, projectId)
    expect(() => parseBundle(JSON.stringify({ ...bundle, version: BUNDLE_VERSION + 1 }))).toThrow(
      '新しい版'
    )
    expect(() =>
      parseBundle(
        JSON.stringify({ ...bundle, messages: [{ ...bundle.messages[0], thread_id: 'unknown' }] })
      )
    ).toThrow()
  })

  it('スレッドの表示中の分岐を Markdown にする（EXP-02）', () => {
    const { threadId } = seed()
    const md = threadToMarkdown(db, threadId)
    expect(md).toMatch(/^# 京都/)
    expect(md).toContain('添付: memo.txt')
    expect(md).toContain('嵐山や東福寺が有名です。')
    expect(md).not.toContain('奈良の紅葉は？')
  })
})

describe('DB のバックアップ（10.2）', () => {
  it(`${BACKUP_GENERATIONS} 世代まで保持し、1 日以内なら取り直さない`, async () => {
    const file = openDatabase(join(dir, 'lumina.db'))
    ops.createProject(file, { type: 'chat', name: 'バックアップ対象' })
    const backups = join(dir, 'backups')
    for (let i = 0; i < BACKUP_GENERATIONS + 2; i++) {
      await backupNow(file, backups, new Date(2026, 0, 1 + i))
    }
    expect(listBackups(backups)).toHaveLength(BACKUP_GENERATIONS)

    const restored = openDatabase(listBackups(backups)[0].path)
    expect(ops.listProjects(restored).map((p) => p.name)).toEqual(['バックアップ対象'])
    restored.close()

    expect(await runDailyBackup(file, backups)).toBeNull()
    file.close()
    expect(existsSync(backups)).toBe(true)
  })
})
