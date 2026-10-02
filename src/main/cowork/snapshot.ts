/**
 * Cowork のスナップショット（要件 SEC-14）
 * ファイルの変更・上書きの前に変更前の内容を保存する。
 * 内容は snapshots 配下に <threadId>/<snapshotId> として保存し、DB には参照のみを持つ。
 * 対象パスが作業フォルダ内かどうかの検証（pathGuard）は呼び出し側で行う。
 */

import type Database from 'better-sqlite3'
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Snapshot {
  id: string
  thread_id: string
  file_path: string
  /** snapshots ディレクトリからの相対パス（データ保存先の移動・復元に追従できるようにする） */
  stored_path: string
  size_bytes: number
  sha256: string
  created_at: number
}

/**
 * スナップショットの保存先（%APPDATA%\LuminaCode\snapshots）
 */
export function getSnapshotsDir(): string {
  return join(app.getPath('userData'), 'snapshots')
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

/**
 * 変更前のファイル内容をスナップショットとして保存する
 */
export function createSnapshot(
  db: Database.Database,
  snapshotsDir: string,
  threadId: string,
  filePath: string
): Snapshot {
  const content = readFileSync(filePath)
  const snapshot: Snapshot = {
    id: randomUUID(),
    thread_id: threadId,
    file_path: filePath,
    stored_path: join(threadId, randomUUID()),
    size_bytes: content.length,
    sha256: sha256(content),
    created_at: Date.now()
  }

  const storedFile = join(snapshotsDir, snapshot.stored_path)
  mkdirSync(join(snapshotsDir, threadId), { recursive: true })
  writeFileSync(storedFile, content, { flag: 'wx' })

  try {
    db.prepare(
      `
      INSERT INTO snapshots (id, thread_id, file_path, stored_path, size_bytes, sha256, created_at)
      VALUES (@id, @thread_id, @file_path, @stored_path, @size_bytes, @sha256, @created_at)
    `
    ).run(snapshot)
  } catch (error) {
    // DB に記録できなかったファイルは残さない
    rmSync(storedFile, { force: true })
    throw error
  }

  return snapshot
}

export function getSnapshot(db: Database.Database, id: string): Snapshot | null {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Snapshot | undefined
  return row ?? null
}

export function listSnapshotsByThread(db: Database.Database, threadId: string): Snapshot[] {
  return db
    .prepare('SELECT * FROM snapshots WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(threadId) as Snapshot[]
}

/**
 * スナップショットの内容を読み出す（改ざん・破損は sha256 で検出する）
 */
export function readSnapshotContent(snapshotsDir: string, snapshot: Snapshot): Buffer {
  const content = readFileSync(join(snapshotsDir, snapshot.stored_path))
  if (sha256(content) !== snapshot.sha256) {
    throw new Error(`スナップショットの内容が破損しています: ${snapshot.file_path}`)
  }
  return content
}

/**
 * DB に対応するスレッドがなくなったスナップショットのファイルを削除する
 * スレッド・プロジェクトの削除で DB の行はカスケード削除されるが、ファイルは残るため起動時などに呼ぶ
 * 戻り値は削除したスレッドディレクトリの数
 */
export function pruneOrphanSnapshotFiles(db: Database.Database, snapshotsDir: string): number {
  let entries: string[]
  try {
    entries = readdirSync(snapshotsDir)
  } catch {
    return 0
  }

  const threadExists = db.prepare('SELECT 1 FROM threads WHERE id = ?')
  let removed = 0
  for (const threadId of entries) {
    if (threadExists.get(threadId)) continue
    rmSync(join(snapshotsDir, threadId), { recursive: true, force: true })
    removed++
  }
  return removed
}
