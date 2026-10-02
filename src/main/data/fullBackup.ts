/**
 * 全データのバックアップと復元（要件 EXP-03）
 * - バックアップ: 選んだフォルダに「LuminaCode-backup-日時」を作り、DB（オンラインバックアップ）・添付ファイル・
 *   Cowork のスナップショット・Agent SDK のデータ・単価表を写す。API キー（と暗号化の鍵）は含めない。
 *   manifest.json を最後に書くため、途中で失敗したバックアップは復元の対象にならない。
 * - 復元: 実行中のアプリでは DB を開いたまま入れ替えられないため、復元の予約を書いて再起動し、
 *   次の起動時に DB を開く前に入れ替える。今のデータは backups\before-restore-日時 に移して残す。
 * Electron に依存しない形にし、パスは外から渡す（テストのため）。
 */

import type Database from 'better-sqlite3'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { FullBackupPreview } from '@shared/types'
import { ValidationError } from '../db/operations'
import { SCHEMA_VERSION } from '../db/schema'

export const FULL_BACKUP_FORMAT = 'lumina-full-backup'
export const FULL_BACKUP_VERSION = 1
const MANIFEST = 'manifest.json'
const DB_FILE = 'lumina.db'
/** DB 以外に写すもの（データ保存先からの相対パス） */
const ITEMS = ['attachments', 'snapshots', 'agent', 'pricing.json']
/** 復元の予約（データ保存先に置く） */
export const RESTORE_MARKER = 'restore-pending.json'

interface Manifest {
  format: string
  version: number
  app_version: string
  schema_version: number
  created_at: number
  projects: number
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

/**
 * 全データをバックアップする。作ったフォルダのパスを返す
 */
export async function createFullBackup(
  db: Database.Database,
  userData: string,
  destParent: string,
  appVersion: string,
  now = new Date()
): Promise<string> {
  const dir = join(destParent, `LuminaCode-backup-${stamp(now)}`)
  if (existsSync(dir))
    throw new ValidationError('同じ名前のフォルダがあります。少し待ってからやり直してください。')
  mkdirSync(dir, { recursive: true })
  try {
    await db.backup(join(dir, DB_FILE))
    for (const item of ITEMS) {
      const src = join(userData, item)
      if (existsSync(src)) cpSync(src, join(dir, item), { recursive: true })
    }
    const projects = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
    const manifest: Manifest = {
      format: FULL_BACKUP_FORMAT,
      version: FULL_BACKUP_VERSION,
      app_version: appVersion,
      schema_version: SCHEMA_VERSION,
      created_at: now.getTime(),
      projects
    }
    writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2))
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * バックアップのフォルダを確かめ、内容の概要を返す（復元できない場合は ValidationError）
 */
export function inspectFullBackup(dir: string): FullBackupPreview {
  let manifest: Partial<Manifest>
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8')) as Partial<Manifest>
  } catch {
    throw new ValidationError(
      'Lumina Code の全データのバックアップではありません（manifest.json が見つからないか、壊れています）。'
    )
  }
  if (manifest.format !== FULL_BACKUP_FORMAT || typeof manifest.version !== 'number') {
    throw new ValidationError('Lumina Code の全データのバックアップではありません。')
  }
  if (manifest.version > FULL_BACKUP_VERSION) {
    throw new ValidationError(
      '新しいバージョンのアプリで作ったバックアップのため、復元できません。'
    )
  }
  if (typeof manifest.schema_version !== 'number' || manifest.schema_version > SCHEMA_VERSION) {
    throw new ValidationError(
      '新しいバージョンのアプリで作ったバックアップのため、復元できません。アプリを更新してください。'
    )
  }
  if (!existsSync(join(dir, DB_FILE))) {
    throw new ValidationError('バックアップにデータベースがありません。')
  }
  return {
    path: dir,
    created_at: typeof manifest.created_at === 'number' ? manifest.created_at : 0,
    app_version: typeof manifest.app_version === 'string' ? manifest.app_version : '',
    projects: typeof manifest.projects === 'number' ? manifest.projects : 0
  }
}

/** 復元を予約する（次の起動時に applyPendingRestore が入れ替える） */
export function scheduleRestore(userData: string, backupDir: string): void {
  inspectFullBackup(backupDir)
  writeFileSync(join(userData, RESTORE_MARKER), JSON.stringify({ path: backupDir }))
}

/**
 * 予約された復元を行う（DB を開く前に呼ぶ）。結果: 復元した／予約なし／失敗（今のデータのまま）
 */
export function applyPendingRestore(
  userData: string,
  now = new Date()
):
  | { status: 'restored'; previous: string }
  | { status: 'none' }
  | { status: 'failed'; error: string } {
  const marker = join(userData, RESTORE_MARKER)
  if (!existsSync(marker)) return { status: 'none' }
  let backupDir: string
  try {
    backupDir = (JSON.parse(readFileSync(marker, 'utf-8')) as { path: string }).path
    inspectFullBackup(backupDir)
  } catch (error) {
    rmSync(marker, { force: true })
    return { status: 'failed', error: (error as Error).message }
  }
  rmSync(marker, { force: true })

  // 今のデータを退避する（DB の WAL も一緒に動かす）
  const previous = join(userData, 'backups', `before-restore-${stamp(now)}`)
  mkdirSync(previous, { recursive: true })
  const current = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, ...ITEMS]
  const moved: string[] = []
  try {
    for (const item of current) {
      if (!existsSync(join(userData, item))) continue
      renameSync(join(userData, item), join(previous, item))
      moved.push(item)
    }
    cpSync(join(backupDir, DB_FILE), join(userData, DB_FILE))
    for (const item of ITEMS) {
      const src = join(backupDir, item)
      if (existsSync(src)) cpSync(src, join(userData, item), { recursive: true })
    }
    return { status: 'restored', previous }
  } catch (error) {
    // 途中で失敗したら、写したものを消して元に戻す
    for (const item of [DB_FILE, ...ITEMS])
      rmSync(join(userData, item), { recursive: true, force: true })
    for (const item of moved) renameSync(join(previous, item), join(userData, item))
    rmSync(previous, { recursive: true, force: true })
    return { status: 'failed', error: (error as Error).message }
  }
}
