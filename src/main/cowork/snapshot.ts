/**
 * Cowork のスナップショット（要件 SEC-14）
 * ファイルの変更・上書きの前に変更前の内容を保存する。
 * 内容は snapshots 配下に <threadId>/<snapshotId> として保存し、DB には参照のみを持つ。
 * 対象パスが作業フォルダ内かどうかの検証（pathGuard）は呼び出し側で行う。
 */

import type Database from 'better-sqlite3'
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileChange } from '@shared/types'
import { moveToTrash, restoreTrashedPath, TRASH_DIR } from './trash'
import { displayPath, rootFor } from './folders'
import { isInsideWorkFolder } from '../security/pathGuard'

export interface Snapshot {
  id: string
  thread_id: string
  file_path: string
  /** snapshots ディレクトリからの相対パス（データ保存先の移動・復元に追従できるようにする） */
  stored_path: string
  size_bytes: number
  sha256: string
  created_at: number
  /** 変更を行った実行（応答メッセージ）。一括 Undo の単位（SEC-15） */
  message_id: string | null
  kind: 'modified' | 'created' | 'trashed'
  /** kind = trashed のときの退避先 */
  trash_path: string | null
  restored_at: number | null
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
  filePath: string,
  messageId: string | null = null
): Snapshot {
  const content = readFileSync(filePath)
  const snapshot: Snapshot = {
    id: randomUUID(),
    thread_id: threadId,
    file_path: filePath,
    stored_path: join(threadId, randomUUID()),
    size_bytes: content.length,
    sha256: sha256(content),
    created_at: Date.now(),
    message_id: messageId,
    kind: 'modified',
    trash_path: null,
    restored_at: null
  }

  const storedFile = join(snapshotsDir, snapshot.stored_path)
  mkdirSync(join(snapshotsDir, threadId), { recursive: true })
  writeFileSync(storedFile, content, { flag: 'wx' })

  try {
    db.prepare(
      `
      INSERT INTO snapshots (id, thread_id, file_path, stored_path, size_bytes, sha256, created_at,
        message_id, kind, trash_path, restored_at)
      VALUES (@id, @thread_id, @file_path, @stored_path, @size_bytes, @sha256, @created_at,
        @message_id, @kind, @trash_path, @restored_at)
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

/**
 * 内容を持たない変更（新規作成・退避）を記録する
 */
export function recordChange(
  db: Database.Database,
  input: {
    threadId: string
    messageId: string
    filePath: string
    kind: 'created' | 'trashed'
    trashPath?: string
  }
): void {
  db.prepare(
    `INSERT INTO snapshots (id, thread_id, file_path, stored_path, size_bytes, sha256, created_at,
       message_id, kind, trash_path)
     VALUES (?, ?, ?, '', 0, '', ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.threadId,
    input.filePath,
    Date.now(),
    input.messageId,
    input.kind,
    input.trashPath ?? null
  )
}

function listByMessage(db: Database.Database, messageId: string): Snapshot[] {
  return db
    .prepare('SELECT * FROM snapshots WHERE message_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(messageId) as Snapshot[]
}

/** ファイルごとに、その実行で最初の記録（実行前の状態）を返す */
function firstPerFile(records: Snapshot[]): Snapshot[] {
  const seen = new Map<string, Snapshot>()
  for (const r of records) {
    const key = r.file_path.toLowerCase()
    if (!seen.has(key)) seen.set(key, r)
  }
  return [...seen.values()]
}

/**
 * 実行（応答メッセージ）単位の変更の一覧（SEC-15）
 */
export function listChanges(
  db: Database.Database,
  workRoot: string,
  messageId: string
): FileChange[] {
  return firstPerFile(listByMessage(db, messageId)).map((r) => ({
    snapshotId: r.id,
    path: displayPath(workRoot, r.file_path),
    kind: r.kind,
    restored: r.restored_at !== null
  }))
}

export interface UndoResult {
  restored: string[]
  skipped: { path: string; reason: string }[]
}

/**
 * 実行単位で「ここまでの変更を元に戻す」（SEC-15）
 * 新しく作られたファイルは消さずに退避する。Bash 経由の変更は対象外（SEC-16）。
 */
export function undoRun(
  db: Database.Database,
  snapshotsDir: string,
  workRoot: string,
  messageId: string,
  /** 読み書きの追加フォルダ（COW-12。退避はそれぞれのフォルダの .lumina-trash に行う） */
  writeRoots: string[] = []
): UndoResult {
  const roots = [workRoot, ...writeRoots]
  const records = firstPerFile(listByMessage(db, messageId).filter((r) => r.restored_at === null))
  const result: UndoResult = { restored: [], skipped: [] }
  // 後から行った変更から順に戻す
  for (const r of [...records].reverse()) {
    const path = displayPath(workRoot, r.file_path)
    try {
      if (r.kind === 'modified') {
        const content = readSnapshotContent(snapshotsDir, r)
        mkdirSync(dirname(r.file_path), { recursive: true })
        writeFileSync(r.file_path, content)
      } else if (r.kind === 'created') {
        if (existsSync(r.file_path)) {
          moveToTrash(rootFor(roots, r.file_path) ?? workRoot, [r.file_path])
        }
      } else if (r.trash_path) {
        const trashPath = r.trash_path
        const root =
          roots.find((root) => isInsideWorkFolder(join(root, TRASH_DIR), trashPath)) ?? workRoot
        restoreTrashedPath(root, trashPath)
      }
      result.restored.push(path)
    } catch (error) {
      result.skipped.push({ path, reason: (error as Error).message })
    }
  }
  db.prepare(
    'UPDATE snapshots SET restored_at = ? WHERE message_id = ? AND restored_at IS NULL'
  ).run(Date.now(), messageId)
  return result
}

const MAX_DIFF_BYTES = 1024 * 1024

function readText(read: () => Buffer): string | null {
  const bytes = read()
  if (bytes.length > MAX_DIFF_BYTES) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * 変更前後の内容（差分表示用。SEC-15）。テキストでない・大きすぎる場合は null
 */
export function snapshotDiff(
  db: Database.Database,
  snapshotsDir: string,
  workRoot: string,
  snapshotId: string
): { path: string; before: string | null; after: string | null; binary: boolean } | null {
  const r = getSnapshot(db, snapshotId)
  if (!r) return null
  const before =
    r.kind === 'modified'
      ? readText(() => readSnapshotContent(snapshotsDir, r))
      : r.kind === 'created'
        ? ''
        : null
  const after = existsSync(r.file_path) ? readText(() => readFileSync(r.file_path)) : ''
  return {
    path: displayPath(workRoot, r.file_path),
    before,
    after,
    binary: before === null || after === null
  }
}
