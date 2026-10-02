/**
 * DB の自動バックアップ（要件 10.2【推奨】: DB を日次で世代管理する。直近 7 世代）
 */

import type Database from 'better-sqlite3'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupInfo } from '@shared/types'

export const BACKUP_GENERATIONS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const PATTERN = /^lumina-\d{8}-\d{6}\.db$/

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

export function listBackups(dir: string): BackupInfo[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => PATTERN.test(n))
    .map((n) => {
      const stat = statSync(join(dir, n))
      return { path: join(dir, n), created_at: stat.mtimeMs, size_bytes: stat.size }
    })
    .sort((a, b) => b.created_at - a.created_at)
}

/** 古い世代を削除する */
function prune(dir: string, keep: number): void {
  for (const old of listBackups(dir).slice(keep)) rmSync(old.path, { force: true })
}

/**
 * 今すぐバックアップする（SQLite のオンラインバックアップ。使用中でも整合したコピーになる）
 */
export async function backupNow(
  db: Database.Database,
  dir: string,
  now = new Date()
): Promise<BackupInfo> {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `lumina-${stamp(now)}.db`)
  await db.backup(path)
  prune(dir, BACKUP_GENERATIONS)
  const stat = statSync(path)
  return { path, created_at: stat.mtimeMs, size_bytes: stat.size }
}

/**
 * 前回のバックアップから 1 日以上たっていればバックアップする（起動時に呼ぶ）
 */
export async function runDailyBackup(
  db: Database.Database,
  dir: string,
  now = new Date()
): Promise<BackupInfo | null> {
  const latest = listBackups(dir)[0]
  if (latest && now.getTime() - latest.created_at < DAY_MS) return null
  return backupNow(db, dir, now)
}
