import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import {
  addFolder,
  displayPath,
  listFolders,
  removeFolder,
  rootFor,
  rootsOf,
  setFolderAccess
} from '../../src/main/cowork/folders'

let db: Database.Database
let base: string
let work: string
let projectId: string
const policy = () => ({
  userDataPath: join(base, 'userData'),
  homeDir: join(base, 'home', 'user'),
  systemRoot: 'C:\Windows'
})

beforeEach(() => {
  db = createInMemoryDatabase()
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'lumina-folders-')))
  work = join(base, 'proj', 'work')
  for (const d of ['proj/work/sub', 'docs', 'src2', 'userData', 'home/user']) {
    mkdirSync(join(base, d), { recursive: true })
  }
  projectId = ops.createProject(db, { type: 'cowork', name: 'C', work_folder: work }).id
})
afterEach(() => {
  db.close()
  rmSync(base, { recursive: true, force: true })
})

describe('追加のフォルダ（COW-12）', () => {
  it('追加・権限の変更・解除ができ、実行時のフォルダに反映する', () => {
    addFolder(db, projectId, work, join(base, 'docs'), 'read', policy())
    addFolder(db, projectId, work, join(base, 'src2'), 'write', policy())
    expect(rootsOf(db, projectId, work)).toEqual({
      workRoot: work,
      writeRoots: [join(base, 'src2')],
      readRoots: [join(base, 'docs')]
    })
    setFolderAccess(db, projectId, join(base, 'docs'), 'write')
    expect(rootsOf(db, projectId, work).writeRoots).toHaveLength(2)
    expect(removeFolder(db, projectId, join(base, 'docs'))).toEqual([
      { path: join(base, 'src2'), access: 'write' }
    ])
    expect(listFolders(db, projectId)).toHaveLength(1)
  })

  it('作業フォルダ・追加済みのフォルダと重なるもの、指定できないフォルダは追加しない', () => {
    expect(() => addFolder(db, projectId, work, join(work, 'sub'), 'read', policy())).toThrow(
      '作業フォルダと重なる'
    )
    expect(() => addFolder(db, projectId, work, join(base, 'proj'), 'read', policy())).toThrow(
      '作業フォルダと重なる'
    )
    addFolder(db, projectId, work, join(base, 'docs'), 'read', policy())
    expect(() => addFolder(db, projectId, work, join(base, 'docs'), 'write', policy())).toThrow(
      '追加済み'
    )
    expect(() => addFolder(db, projectId, work, join(base, 'userData'), 'read', policy())).toThrow(
      '指定できません'
    )
    expect(() => addFolder(db, projectId, work, join(base, 'nope'), 'read', policy())).toThrow(
      '見つかりません'
    )
    expect(() => setFolderAccess(db, projectId, join(base, 'src2'), 'write')).toThrow(
      '見つかりません'
    )
  })

  it('パスを含むフォルダと、表示用のパス', () => {
    const roots = [work, join(base, 'src2')]
    expect(rootFor(roots, join(base, 'src2', 'a.txt'))).toBe(join(base, 'src2'))
    expect(rootFor(roots, join(base, 'docs', 'a.txt'))).toBeNull()
    expect(displayPath(work, join(work, 'sub', 'a.txt'))).toBe(join('sub', 'a.txt'))
    expect(displayPath(work, join(base, 'src2', 'a.txt'))).toBe(join(base, 'src2', 'a.txt'))
  })
})
