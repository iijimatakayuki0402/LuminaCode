import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSnapshots, runGit, SNAPSHOT_PREFIX } from '../../src/main/cowork/gitSnapshot'

let work: string
const git = (...args: string[]): Promise<string> => runGit(args, { cwd: work })
const snapshots = new GitSnapshots()

beforeEach(async () => {
  if (process.versions.electron) return
  work = realpathSync.native(mkdtempSync(join(tmpdir(), 'lumina-git-作業 ')))
  await git('init', '-q')
  writeFileSync(join(work, 'a.txt'), 'v1')
  writeFileSync(join(work, '.gitignore'), 'ignored.log\n')
  await git('add', '.')
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
})
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true })
})

// Electron のランタイム（npm run test:electron）では、子プロセスを起動したテストのワーカーが終了時に異常終了するため
// 実行しない（テストは通ったうえでワーカーが落ちる。本番の main プロセスでの動作は実機で確認する）
describe.skipIf(Boolean(process.versions.electron))('Git のスナップショット（COW-10）', () => {
  it('リポジトリでないフォルダでは使えないと返す', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'lumina-plain-'))
    try {
      expect(await snapshots.status(plain)).toEqual({ available: true, repo: false, snapshots: [] })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('ブランチ・ステージングに触れずに、追跡していないファイルも含めて記録する', async () => {
    writeFileSync(join(work, 'a.txt'), 'v2')
    writeFileSync(join(work, 'new.txt'), 'new')
    writeFileSync(join(work, 'ignored.log'), 'log')
    const headBefore = await git('rev-parse', 'HEAD')
    const statusBefore = await git('status', '--porcelain')

    const ref = await snapshots.snapshot(work, 'Cowork の実行前: テスト')
    expect(ref.startsWith(SNAPSHOT_PREFIX)).toBe(true)
    expect(await git('rev-parse', 'HEAD')).toBe(headBefore)
    expect(await git('status', '--porcelain')).toBe(statusBefore)

    const files = (await git('ls-tree', '-r', '--name-only', ref)).trim().split('\n')
    expect(files.sort()).toEqual(['.gitignore', 'a.txt', 'new.txt'])
    expect(await git('show', `${ref}:a.txt`)).toBe('v2')

    const [listed] = (await snapshots.status(work)).snapshots
    expect(listed).toMatchObject({ ref, message: 'Cowork の実行前: テスト' })
  })

  it('差分を示し、記録した時点に戻す（増えたファイルは退避し、戻す前の状態も記録する）', async () => {
    const ref = await snapshots.snapshot(work, 'before')
    writeFileSync(join(work, 'a.txt'), 'changed by cowork')
    writeFileSync(join(work, 'added.txt'), 'added')
    rmSync(join(work, '.gitignore'))

    const diff = await snapshots.diff(work, ref)
    expect(diff).toContain('a.txt')
    expect(diff).toContain('added.txt')

    const { trashed } = await snapshots.restore(work, ref, new Date(2026, 9, 3, 12, 0, 0))
    expect(trashed).toBe(1)
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('v1')
    expect(existsSync(join(work, '.gitignore'))).toBe(true)
    expect(existsSync(join(work, 'added.txt'))).toBe(false)
    expect(readdirSync(join(work, '.lumina-trash')).length).toBeGreaterThan(0)

    const list = (await snapshots.status(work)).snapshots
    expect(list.map((s) => s.message)).toEqual(['戻す前の状態', 'before'])
    // 戻す前の状態には Cowork の変更が残っている
    expect(await git('show', `${list[0].ref}:a.txt`)).toBe('changed by cowork')
    // ステージングは変えていない
    expect(await git('diff', '--cached', '--name-only')).toBe('')
  })

  it('スナップショット以外の参照は扱わない', async () => {
    await expect(snapshots.diff(work, 'HEAD')).rejects.toThrow('正しくありません')
    await expect(snapshots.restore(work, `${SNAPSHOT_PREFIX}../../heads/main`)).rejects.toThrow(
      '正しくありません'
    )
  })
})
