/**
 * データベース初期化のテスト
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/init'
import Database from 'better-sqlite3'
import { MIGRATIONS, SCHEMA_VERSION } from '../../src/main/db/schema'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumina-db-'))
  dbPath = join(dir, 'lumina.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const versions = (db: ReturnType<typeof openDatabase>): number[] =>
  (
    db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]
  ).map((row) => row.version)

describe('openDatabase', () => {
  it('新規DBにスキーマを作成し、バージョンを記録する', () => {
    const db = openDatabase(dbPath)

    expect(versions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('既存DBを開き直してもマイグレーションを重複適用しない', () => {
    openDatabase(dbPath).close()
    const db = openDatabase(dbPath)

    expect(versions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    db.close()
  })

  it('アプリより新しいスキーマのDBは開かない', () => {
    const db = openDatabase(dbPath)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION + 1,
      Date.now()
    )
    db.close()

    expect(() => openDatabase(dbPath)).toThrow(/新しい/)
  })

  it('v1 の DB を最新に更新しても既存のデータを保持する', () => {
    // v1 だけを適用した DB を作る
    const v1 = new Database(dbPath)
    v1.exec(
      'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
    )
    for (const sql of MIGRATIONS[0].statements) v1.exec(sql)
    v1.prepare('INSERT INTO schema_version VALUES (1, 0)').run()
    v1.exec(`INSERT INTO projects (id, type, name, created_at, updated_at) VALUES ('p', 'chat', 'P', 0, 0);
      INSERT INTO threads (id, project_id, created_at, updated_at) VALUES ('t', 'p', 0, 0);
      INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('m', 't', 'user', 'hi', 0);`)
    v1.close()

    const db = openDatabase(dbPath)
    expect(versions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(db.prepare('SELECT content, status FROM messages').get()).toEqual({
      content: 'hi',
      status: 'complete'
    })
    // v8: 思考は以前から常にオンだったため、既存のスレッドはオンにする（CHT-07）
    expect(db.prepare('SELECT extended_thinking FROM threads').get()).toEqual({
      extended_thinking: 1
    })
    db.close()
  })
})
