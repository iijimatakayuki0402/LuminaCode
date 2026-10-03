import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listTrash,
  moveToTrash,
  purgeTrash,
  restoreFromTrash,
  TRASH_DIR
} from '../../src/main/cowork/trash'

let work: string

beforeEach(() => {
  work = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'lumina-trash-'))), 'work')
  mkdirSync(join(work, 'src', 'deep'), { recursive: true })
  writeFileSync(join(work, 'src', 'deep', 'a.ts'), 'A')
  writeFileSync(join(work, 'b.txt'), 'BB')
})
afterEach(() => rmSync(join(work, '..'), { recursive: true, force: true }))

describe('退避（SEC-10、SEC-11）', () => {
  it('元の相対パス構造を保って .lumina-trash\\<日時>\\ に移動する', () => {
    const moved = moveToTrash(work, ['src', 'b.txt'], new Date(2026, 9, 2, 13, 4, 5, 6))
    expect(moved.map((m) => [m.isFolder, m.size_bytes])).toEqual([
      [true, 1],
      [false, 2]
    ])
    const stampDir = join(work, TRASH_DIR, '20261002-130405-006')
    expect(readFileSync(join(stampDir, 'src', 'deep', 'a.ts'), 'utf-8')).toBe('A')
    expect(existsSync(join(work, 'src'))).toBe(false)
    expect(
      listTrash(work)
        .map((e) => e.originalPath)
        .sort()
    ).toEqual(['b.txt', 'src'])
  })

  it('復元できる。同名のファイルがある場合は復元しない', () => {
    moveToTrash(work, ['b.txt'])
    const [entry] = listTrash(work)
    writeFileSync(join(work, 'b.txt'), 'other')
    expect(() => restoreFromTrash(work, entry.id)).toThrow('同じ名前')

    rmSync(join(work, 'b.txt'))
    expect(restoreFromTrash(work, entry.id)).toBe('b.txt')
    expect(readFileSync(join(work, 'b.txt'), 'utf-8')).toBe('BB')
    expect(listTrash(work)).toEqual([])
    expect(existsSync(join(work, TRASH_DIR))).toBe(true)
  })

  it('作業フォルダ外・作業フォルダそのもの・退避先・存在しないパスは扱わない', () => {
    expect(() => moveToTrash(work, ['../x'])).toThrow('作業フォルダ内')
    expect(() => moveToTrash(work, ['.'])).toThrow('作業フォルダ内')
    expect(() => moveToTrash(work, ['missing.txt'])).toThrow('見つかりません')
    moveToTrash(work, ['b.txt'])
    expect(() => moveToTrash(work, [TRASH_DIR])).toThrow('退避先')
    expect(() => restoreFromTrash(work, '..\\..\\x')).toThrow('見つかりません')
  })

  it('保持期間を過ぎたものだけを完全に削除する', () => {
    const now = new Date(2026, 9, 2).getTime()
    moveToTrash(work, ['b.txt'], new Date(now - 31 * 86400000))
    moveToTrash(work, ['src'], new Date(now - 1 * 86400000))
    expect(purgeTrash(work, 30, now)).toBe(1)
    expect(listTrash(work).map((e) => e.originalPath)).toEqual(['src'])
  })
})

describe('退避の補強', () => {
  it('フォルダと中のファイルを同時に指定しても、フォルダごと退避して一覧に残す', () => {
    moveToTrash(work, ['src', join('src', 'deep', 'a.ts')])
    expect(listTrash(work).map((e) => e.originalPath)).toEqual(['src'])
  })

  it('同じ時刻の退避が重なっても、先に退避したものを一覧から失わない', () => {
    const at = new Date(2026, 9, 2, 13, 4, 5, 6)
    moveToTrash(work, ['b.txt'], at)
    moveToTrash(work, ['src'], at)
    expect(
      listTrash(work)
        .map((e) => e.originalPath)
        .sort()
    ).toEqual(['b.txt', 'src'])
  })

  it('退避の記録ファイル自体は復元できない', () => {
    moveToTrash(work, ['b.txt'], new Date(2026, 9, 2, 13, 4, 5, 6))
    expect(() => restoreFromTrash(work, join('20261002-130405-006', '.manifest.json'))).toThrow()
  })
})
