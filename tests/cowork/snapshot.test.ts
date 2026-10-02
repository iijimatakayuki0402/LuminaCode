/**
 * スナップショットのテスト
 */

import type Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSnapshot,
  getSnapshot,
  listSnapshotsByThread,
  pruneOrphanSnapshotFiles,
  readSnapshotContent
} from '../../src/main/cowork/snapshot'
import { createInMemoryDatabase } from '../../src/main/db/init'
import { createProject, createThread, deleteThread } from '../../src/main/db/operations'

let db: Database.Database
let base: string
let work: string
let snapshotsDir: string
let threadId: string

beforeEach(() => {
  db = createInMemoryDatabase()
  base = mkdtempSync(join(tmpdir(), 'lumina-snapshot-'))
  work = join(base, 'work')
  snapshotsDir = join(base, 'snapshots')
  const project = createProject(db, { type: 'cowork', name: 'Cowork', work_folder: work })
  threadId = createThread(db, { project_id: project.id }).id
  writeFileSync(join(base, 'target.txt'), '変更前の内容')
})

afterEach(() => {
  db.close()
  rmSync(base, { recursive: true, force: true })
})

describe('createSnapshot', () => {
  it('内容をファイルに保存し、DBには参照を記録する', () => {
    const target = join(base, 'target.txt')
    const snapshot = createSnapshot(db, snapshotsDir, threadId, target)

    // 元ファイルを変更してもスナップショットは変更前の内容を保つ
    writeFileSync(target, '変更後の内容')

    expect(getSnapshot(db, snapshot.id)).toEqual(snapshot)
    expect(snapshot.file_path).toBe(target)
    expect(snapshot.size_bytes).toBe(Buffer.byteLength('変更前の内容'))
    expect(readSnapshotContent(snapshotsDir, snapshot).toString()).toBe('変更前の内容')

    const columns = db.prepare('PRAGMA table_info(snapshots)').all() as { name: string }[]
    expect(columns.map((c) => c.name)).not.toContain('content')
  })

  it('スレッドごとに新しい順で一覧できる', () => {
    const target = join(base, 'target.txt')
    const s1 = createSnapshot(db, snapshotsDir, threadId, target)
    const s2 = createSnapshot(db, snapshotsDir, threadId, target)

    expect(listSnapshotsByThread(db, threadId).map((s) => s.id)).toEqual([s2.id, s1.id])
  })

  it('DBへの記録に失敗したらファイルを残さない', () => {
    expect(() =>
      createSnapshot(db, snapshotsDir, 'no-such-thread', join(base, 'target.txt'))
    ).toThrow()
    expect(readdirSync(join(snapshotsDir, 'no-such-thread'))).toEqual([])
  })

  it('保存した内容の破損を検出する', () => {
    const snapshot = createSnapshot(db, snapshotsDir, threadId, join(base, 'target.txt'))
    writeFileSync(join(snapshotsDir, snapshot.stored_path), '書き換え')

    expect(() => readSnapshotContent(snapshotsDir, snapshot)).toThrow('破損')
  })
})

describe('pruneOrphanSnapshotFiles', () => {
  it('削除済みスレッドのファイルだけを削除する', () => {
    const project = createProject(db, { type: 'cowork', name: '残す', work_folder: work })
    const keepThread = createThread(db, { project_id: project.id }).id
    const target = join(base, 'target.txt')
    const kept = createSnapshot(db, snapshotsDir, keepThread, target)
    createSnapshot(db, snapshotsDir, threadId, target)

    deleteThread(db, threadId)

    expect(pruneOrphanSnapshotFiles(db, snapshotsDir)).toBe(1)
    expect(existsSync(join(snapshotsDir, threadId))).toBe(false)
    expect(readSnapshotContent(snapshotsDir, kept).toString()).toBe('変更前の内容')
  })

  it('保存先がまだ無ければ何もしない', () => {
    expect(pruneOrphanSnapshotFiles(db, join(base, 'none'))).toBe(0)
  })
})
