import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isInsideWorkFolder } from '../src/main/security/pathGuard'

const BS = String.fromCharCode(92)
let base: string
let work: string
let outside: string

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lumina-guard-'))
  work = join(base, 'work')
  outside = join(base, 'outside')
  mkdirSync(join(work, 'sub'), { recursive: true })
  mkdirSync(outside)
  mkdirSync(join(base, 'work2'))
  writeFileSync(join(work, 'a.txt'), 'a')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('isInsideWorkFolder', () => {
  it('作業フォルダ内の既存／未作成のパスを許可する', () => {
    expect(isInsideWorkFolder(work, 'a.txt')).toBe(true)
    expect(isInsideWorkFolder(work, 'sub/new/file.txt')).toBe(true)
    expect(isInsideWorkFolder(work, join(work, 'sub'))).toBe(true)
    expect(isInsideWorkFolder(work, '.')).toBe(true)
  })

  it('.. による脱出と、フォルダ外の絶対パスを拒否する', () => {
    expect(isInsideWorkFolder(work, '../outside/secret.txt')).toBe(false)
    expect(isInsideWorkFolder(work, 'sub/../../outside')).toBe(false)
    expect(isInsideWorkFolder(work, join(outside, 'secret.txt'))).toBe(false)
  })

  it('名前が前方一致する兄弟フォルダ（work2）を拒否する', () => {
    expect(isInsideWorkFolder(work, join(base, 'work2'))).toBe(false)
    expect(isInsideWorkFolder(work, '../work2/x.txt')).toBe(false)
  })

  it('ジャンクション／シンボリックリンク経由の脱出を拒否する', () => {
    symlinkSync(outside, join(work, 'link-dir'), 'junction')
    expect(isInsideWorkFolder(work, 'link-dir/secret.txt')).toBe(false)
    expect(isInsideWorkFolder(work, 'link-dir/new.txt')).toBe(false)
    expect(isInsideWorkFolder(work, 'link-dir')).toBe(false)
  })

  it('ファイルのシンボリックリンクによる脱出を拒否する（権限がある場合）', (ctx) => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(work, 'link-file.txt'), 'file')
    } catch {
      ctx.skip()
      return
    }
    expect(isInsideWorkFolder(work, 'link-file.txt')).toBe(false)
  })

  it('作業フォルダ内を指すリンクは許可する', () => {
    symlinkSync(join(work, 'sub'), join(work, 'inner-link'), 'junction')
    expect(isInsideWorkFolder(work, 'inner-link/x.txt')).toBe(true)
  })

  it('大文字小文字の違い・8.3 短縮名の作業フォルダでも正しく判定する（Windows）', (ctx) => {
    if (process.platform !== 'win32') return ctx.skip()
    expect(isInsideWorkFolder(work.toUpperCase(), join(work, 'a.txt'))).toBe(true)
    expect(isInsideWorkFolder(work.toLowerCase(), '../outside/secret.txt')).toBe(false)
  })

  it('UNC・デバイスパス・代替データストリーム・NUL を拒否する（Windows）', (ctx) => {
    if (process.platform !== 'win32') return ctx.skip()
    expect(isInsideWorkFolder(work, [BS + BS, 'server', BS, 'share', BS, 'x.txt'].join(''))).toBe(
      false
    )
    expect(
      isInsideWorkFolder(work, [BS + BS, '?', BS, 'C:', BS, 'Windows', BS, 'win.ini'].join(''))
    ).toBe(false)
    expect(isInsideWorkFolder(work, 'a.txt:stream')).toBe(false)
    expect(isInsideWorkFolder(work, 'a\0.txt')).toBe(false)
  })
})
