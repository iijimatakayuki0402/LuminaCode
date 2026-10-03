import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { SCHEMA_VERSION } from '../../src/main/db/schema'
import {
  applyPendingRestore,
  createFullBackup,
  inspectFullBackup,
  RESTORE_MARKER,
  scheduleRestore
} from '../../src/main/data/fullBackup'

let base: string
let userData: string
let dest: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lumina-full-'))
  userData = join(base, 'userData')
  dest = join(base, 'dest')
  mkdirSync(join(userData, 'attachments', 'ab'), { recursive: true })
  mkdirSync(join(userData, 'agent'), { recursive: true })
  mkdirSync(dest)
  writeFileSync(join(userData, 'attachments', 'ab', 'file.bin'), 'attachment')
  writeFileSync(join(userData, 'agent', 'session.jsonl'), 'session')
  writeFileSync(join(userData, 'pricing.json'), '{}')
  writeFileSync(join(userData, 'api-key.bin'), 'secret')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const NOW = new Date(2026, 9, 3, 12, 0, 0)

async function backupWith(name: string): Promise<string> {
  const db = openDatabase(join(userData, 'lumina.db'))
  ops.createProject(db, { type: 'chat', name })
  const dir = await createFullBackup(db, userData, dest, '0.0.1', NOW)
  db.close()
  return dir
}

describe('全データのバックアップと復元（EXP-03）', () => {
  it('DB・添付ファイル・Agent SDK のデータ・単価表を写し、API キーは含めない', async () => {
    const dir = await backupWith('旅行')
    expect(dir).toBe(join(dest, 'LuminaCode-backup-20261003-120000'))
    expect(readFileSync(join(dir, 'attachments', 'ab', 'file.bin'), 'utf-8')).toBe('attachment')
    expect(existsSync(join(dir, 'agent', 'session.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'pricing.json'))).toBe(true)
    expect(existsSync(join(dir, 'api-key.bin'))).toBe(false)
    expect(inspectFullBackup(dir)).toEqual({
      path: dir,
      created_at: NOW.getTime(),
      app_version: '0.0.1',
      projects: 1
    })
  })

  it('予約した復元を次の起動時に行い、今のデータは退避して残す', async () => {
    const dir = await backupWith('バックアップ時点')
    // バックアップ後にデータを変える
    const db = openDatabase(join(userData, 'lumina.db'))
    ops.createProject(db, { type: 'chat', name: '後から作った' })
    db.close()
    writeFileSync(join(userData, 'attachments', 'ab', 'file.bin'), 'changed')

    scheduleRestore(userData, dir)
    expect(existsSync(join(userData, RESTORE_MARKER))).toBe(true)
    const result = applyPendingRestore(userData, NOW)
    expect(result).toEqual({
      status: 'restored',
      previous: join(userData, 'backups', 'before-restore-20261003-120000')
    })
    expect(existsSync(join(userData, RESTORE_MARKER))).toBe(false)

    const restored = new Database(join(userData, 'lumina.db'), { readonly: true })
    expect(restored.prepare('SELECT name FROM projects').all()).toEqual([
      { name: 'バックアップ時点' }
    ])
    restored.close()
    expect(readFileSync(join(userData, 'attachments', 'ab', 'file.bin'), 'utf-8')).toBe(
      'attachment'
    )
    // API キーはそのまま
    expect(readFileSync(join(userData, 'api-key.bin'), 'utf-8')).toBe('secret')
    // 復元前のデータは残っている
    if (result.status !== 'restored') throw new Error()
    expect(readFileSync(join(result.previous, 'attachments', 'ab', 'file.bin'), 'utf-8')).toBe(
      'changed'
    )
    expect(applyPendingRestore(userData)).toEqual({ status: 'none' })
  })

  it('入れ替えの途中で失敗したら、退避していないデータには触れずに元へ戻す', async () => {
    const dir = await backupWith('バックアップ時点')
    writeFileSync(join(userData, 'attachments', 'ab', 'file.bin'), 'changed')
    // agent の退避だけが失敗するよう、退避先に同じ名前の空でないフォルダを置く
    const previous = join(userData, 'backups', 'before-restore-20261003-120000')
    mkdirSync(join(previous, 'agent'), { recursive: true })
    writeFileSync(join(previous, 'agent', 'busy'), '')

    scheduleRestore(userData, dir)
    expect(applyPendingRestore(userData, NOW)).toMatchObject({ status: 'failed' })
    expect(readFileSync(join(userData, 'attachments', 'ab', 'file.bin'), 'utf-8')).toBe('changed')
    expect(readFileSync(join(userData, 'agent', 'session.jsonl'), 'utf-8')).toBe('session')
    expect(existsSync(join(userData, 'pricing.json'))).toBe(true)
    expect(existsSync(join(userData, 'lumina.db'))).toBe(true)
  })

  it('バックアップでないフォルダ・新しいアプリのバックアップは復元できない', async () => {
    expect(() => inspectFullBackup(dest)).toThrow('バックアップではありません')
    const dir = await backupWith('A')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, schema_version: SCHEMA_VERSION + 1 })
    )
    expect(() => scheduleRestore(userData, dir)).toThrow('新しいバージョン')
    expect(existsSync(join(userData, RESTORE_MARKER))).toBe(false)
  })

  it('予約の後にバックアップが消えていたら、今のデータのまま起動する', async () => {
    const dir = await backupWith('A')
    scheduleRestore(userData, dir)
    rmSync(dir, { recursive: true, force: true })
    expect(applyPendingRestore(userData)).toMatchObject({ status: 'failed' })
    expect(existsSync(join(userData, RESTORE_MARKER))).toBe(false)
    expect(existsSync(join(userData, 'lumina.db'))).toBe(true)
    expect(readFileSync(join(userData, 'pricing.json'), 'utf-8')).toBe('{}')
  })
})
