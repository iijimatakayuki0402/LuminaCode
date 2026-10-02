/**
 * データベース初期化のテスト
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/init'
import { SCHEMA_VERSION } from '../../src/main/db/schema'

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

    expect(versions(db)).toEqual([SCHEMA_VERSION])
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('既存DBを開き直してもマイグレーションを重複適用しない', () => {
    openDatabase(dbPath).close()
    const db = openDatabase(dbPath)

    expect(versions(db)).toEqual([SCHEMA_VERSION])
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
})
