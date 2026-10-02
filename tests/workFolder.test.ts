import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ValidationError } from '../src/main/db/operations'
import { validateWorkFolder, type WorkFolderPolicy } from '../src/main/security/workFolder'

let base: string
let policy: WorkFolderPolicy

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'lumina-wf-'))
  for (const d of [
    'Windows/System32',
    'Users/me/AppData/LuminaCode/sub',
    'Users/me/docs',
    'ok/sub'
  ]) {
    mkdirSync(join(base, d), { recursive: true })
  }
  writeFileSync(join(base, 'file.txt'), 'x')
  policy = {
    userDataPath: join(base, 'Users/me/AppData/LuminaCode'),
    homeDir: join(base, 'Users/me'),
    systemRoot: join(base, 'Windows')
  }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const rejects = (path: string, reason: string): void => {
  expect(() => validateWorkFolder(path, policy)).toThrow(ValidationError)
  expect(() => validateWorkFolder(path, policy)).toThrow(reason)
}

describe('validateWorkFolder（PRJ-05）', () => {
  it('通常のフォルダは実体パスで受け付ける', () => {
    expect(validateWorkFolder(join(base, 'ok'), policy)).toBe(realpathSync.native(join(base, 'ok')))
    expect(validateWorkFolder(join(base, 'Users/me/docs'), policy)).toBe(
      realpathSync.native(join(base, 'Users/me/docs'))
    )
  })

  it('存在しない・ファイル・相対パスは拒否する', () => {
    rejects(join(base, 'missing'), '見つかりません')
    rejects(join(base, 'file.txt'), '見つかりません')
    rejects('relative/path', '絶対パス')
  })

  it('ドライブのルートは拒否する', () => {
    rejects(parse(base).root, 'ドライブのルート')
  })

  it('Windows フォルダとその配下は拒否する', () => {
    rejects(join(base, 'Windows'), 'Windows')
    rejects(join(base, 'Windows/System32'), 'Windows')
  })

  it('ユーザーフォルダそのものと Users は拒否するが、その配下は許可する', () => {
    rejects(join(base, 'Users/me'), 'ユーザーフォルダ')
    rejects(join(base, 'Users'), 'ユーザーフォルダ')
  })

  it('データ保存先の内側と、データ保存先を含むフォルダは拒否する', () => {
    rejects(join(base, 'Users/me/AppData/LuminaCode'), 'データ保存先')
    rejects(join(base, 'Users/me/AppData/LuminaCode/sub'), 'データ保存先')
    rejects(join(base, 'Users/me/AppData'), 'データ保存先')
  })

  it('大文字小文字の違いや .. を含む指定でも判定する', () => {
    rejects(join(base, 'windows', '..', 'WINDOWS', 'system32'), 'Windows')
  })

  it('ジャンクション経由で禁止フォルダを指す場合も拒否する', () => {
    const link = join(base, 'link-to-windows')
    symlinkSync(join(base, 'Windows'), link, 'junction')
    rejects(link, 'Windows')
  })

  it('実環境の Program Files とユーザーフォルダを拒否する', () => {
    const real: WorkFolderPolicy = { ...policy, homeDir: homedir() }
    if (process.platform === 'win32') {
      const programFiles = process.env['ProgramFiles']
      if (programFiles) {
        expect(() => validateWorkFolder(programFiles, real)).toThrow('Program Files')
      }
    }
    expect(() => validateWorkFolder(homedir(), real)).toThrow('ユーザーフォルダ')
  })
})
