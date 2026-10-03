/**
 * Git のスナップショット（要件 COW-10: 作業フォルダが Git リポジトリの場合、変更前の状態を記録する。既定オフ）
 * Cowork の実行前に、作業ツリーの状態（追跡していないファイルを含む。.gitignore に従う）をコミットオブジェクトにし、
 * refs/lumina/snapshots/ に保存する。一時的なインデックスを使うため、ブランチ・コミット・ステージングには触れない。
 * 戻すときは、戻す前の状態も記録してから、スナップショットの内容を書き戻す。スナップショットの後に増えたファイルは
 * 削除せず .lumina-trash に退避する（SEC-10）。
 */

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GitSnapshot, GitStatus } from '@shared/types'
import { ValidationError } from '../db/operations'
import { moveToTrash, TRASH_DIR } from './trash'

export const SNAPSHOT_PREFIX = 'refs/lumina/snapshots/'
export const SNAPSHOTS_KEEP = 50

/** git コマンドの実行（テストで差し替えられるようにする） */
export type GitRunner = (
  args: string[],
  options: { cwd: string; env?: Record<string, string> }
) => Promise<string>

// 記録の操作でリポジトリのフック・fsmonitor（任意のプログラム）が動かないようにする
const SAFE_CONFIG = [
  '-c',
  `core.hooksPath=${join(tmpdir(), 'lumina-code-no-git-hooks')}`,
  '-c',
  'core.fsmonitor=false'
]

export const runGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      }
    )
  })

// ユーザーの Git の設定に名前が無くても記録できるよう、作成者を指定する
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Lumina Code',
  GIT_AUTHOR_EMAIL: 'lumina-code@localhost',
  GIT_COMMITTER_NAME: 'Lumina Code',
  GIT_COMMITTER_EMAIL: 'lumina-code@localhost'
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`

export class GitSnapshots {
  constructor(private readonly git: GitRunner = runGit) {}

  /** git が使えるか、作業フォルダがリポジトリ（の最上位）か */
  async status(workRoot: string): Promise<Omit<GitStatus, 'enabled'>> {
    try {
      await this.git(['--version'], { cwd: workRoot })
    } catch {
      return { available: false, repo: false, snapshots: [] }
    }
    if (!existsSync(join(workRoot, '.git'))) return { available: true, repo: false, snapshots: [] }
    return { available: true, repo: true, snapshots: await this.list(workRoot) }
  }

  async list(workRoot: string): Promise<GitSnapshot[]> {
    const out = await this.git(
      [
        'for-each-ref',
        '--sort=-refname',
        '--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(contents:subject)',
        SNAPSHOT_PREFIX
      ],
      { cwd: workRoot }
    )
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, commit, date, message] = line.split('\0')
        return { ref, commit, created_at: Number(date) * 1000, message }
      })
  }

  /** 作業ツリーの今の状態を記録する。記録した参照名を返す */
  async snapshot(workRoot: string, message: string, now = new Date()): Promise<string> {
    const commit = await this.capture(workRoot, message)
    const ref = `${SNAPSHOT_PREFIX}${stamp(now)}`
    await this.git(['update-ref', ref, commit], { cwd: workRoot })
    await this.prune(workRoot)
    return ref
  }

  /** スナップショットと今の作業ツリーの違い（ファイルごとの状態） */
  async diff(workRoot: string, ref: string): Promise<string> {
    this.checkRef(ref)
    const current = await this.capture(workRoot, 'current')
    return this.git(['diff', '--stat', '--find-renames', ref, current], { cwd: workRoot })
  }

  /**
   * スナップショットの状態に戻す。戻す前の状態を記録し、増えたファイルは .lumina-trash に退避する
   */
  async restore(
    workRoot: string,
    ref: string,
    now = new Date()
  ): Promise<{ before: string; trashed: number }> {
    this.checkRef(ref)
    const commit = (
      await this.git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: workRoot })
    ).trim()
    const before = await this.snapshot(workRoot, '戻す前の状態', now)
    const current = await this.git(['rev-parse', before], { cwd: workRoot })
    // スナップショットの後に増えたファイル
    const added = (
      await this.git(
        ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', commit, current.trim()],
        {
          cwd: workRoot
        }
      )
    )
      .split('\0')
      .filter(Boolean)
    if (added.length > 0) moveToTrash(workRoot, added, now)
    // スナップショットの内容を書き戻す（一時的なインデックスを使い、ステージングには触れない）
    await this.withTempIndex(async (env) => {
      await this.git(['read-tree', commit], { cwd: workRoot, env })
      await this.git(['checkout-index', '--all', '--force'], { cwd: workRoot, env })
    })
    return { before, trashed: added.length }
  }

  /** 作業ツリーをコミットオブジェクトにする（HEAD があれば親にする） */
  private async capture(workRoot: string, message: string): Promise<string> {
    let head: string | null = null
    try {
      head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: workRoot })).trim()
    } catch {
      head = null // まだコミットが無いリポジトリ
    }
    // 本来のインデックスを写してから追加する（変わっていないファイルを読み直さずに済む）
    const realIndex = resolve(
      workRoot,
      (await this.git(['rev-parse', '--git-path', 'index'], { cwd: workRoot })).trim()
    )
    return this.withTempIndex(async (env) => {
      if (existsSync(realIndex)) copyFileSync(realIndex, env['GIT_INDEX_FILE'])
      await this.git(['add', '--all', '--', '.', `:(exclude)${TRASH_DIR}`], { cwd: workRoot, env })
      const tree = (await this.git(['write-tree'], { cwd: workRoot, env })).trim()
      const args = ['commit-tree', tree, '-m', message, ...(head ? ['-p', head] : [])]
      return (await this.git(args, { cwd: workRoot, env: { ...env, ...IDENTITY } })).trim()
    })
  }

  private async withTempIndex<T>(task: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-git-'))
    try {
      return await task({ GIT_INDEX_FILE: join(dir, 'index') })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async prune(workRoot: string): Promise<void> {
    for (const old of (await this.list(workRoot)).slice(SNAPSHOTS_KEEP)) {
      await this.git(['update-ref', '-d', old.ref], { cwd: workRoot })
    }
  }

  private checkRef(ref: string): void {
    if (!ref.startsWith(SNAPSHOT_PREFIX) || !/^[\w/.-]+$/.test(ref) || ref.includes('..')) {
      throw new ValidationError('スナップショットの指定が正しくありません。')
    }
  }
}
