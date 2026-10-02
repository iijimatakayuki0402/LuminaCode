/**
 * 削除の退避（要件 SEC-10、SEC-11）
 * 完全削除はせず、作業フォルダ直下の .lumina-trash\<日時>\ に、元の相対パス構造を保って移動する。
 * 移動した項目は .lumina-trash\<日時>\.manifest.json に記録し、画面から復元できるようにする。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { TrashEntry } from '@shared/types'
import { ValidationError } from '../db/operations'
import { isInsideWorkFolder } from '../security/pathGuard'

export const TRASH_DIR = '.lumina-trash'
const MANIFEST = '.manifest.json'

interface ManifestItem {
  path: string
  isFolder: boolean
  size_bytes: number
}

interface Manifest {
  deletedAt: number
  items: ManifestItem[]
}

export interface TrashedItem {
  originalPath: string
  trashPath: string
  isFolder: boolean
  size_bytes: number
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
const stampOf = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`

/** ファイル・フォルダの合計サイズ */
export function sizeOf(path: string): number {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
}

/** フォルダ内のファイル数（確認ダイアログの件数表示用） */
export function countFiles(path: string): number {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return 1
  return readdirSync(path).reduce((sum, name) => sum + countFiles(join(path, name)), 0)
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8')) as Manifest
  } catch {
    return null
  }
}

/**
 * 退避する。対象は作業フォルダ内の既存のファイル・フォルダに限る
 */
export function moveToTrash(workRoot: string, paths: string[], now = new Date()): TrashedItem[] {
  const root = resolve(workRoot)
  const targets = [...new Set(paths.map((p) => resolve(root, p)))]
  for (const target of targets) {
    if (!isInsideWorkFolder(root, target) || resolve(target) === root) {
      throw new ValidationError(`作業フォルダ内のファイルだけを削除できます: ${target}`)
    }
    if (!existsSync(target))
      throw new ValidationError(`ファイルが見つかりません: ${relative(root, target)}`)
    const rel = relative(root, target)
    if (rel.split(sep)[0]?.toLowerCase() === TRASH_DIR) {
      throw new ValidationError('退避先（.lumina-trash）の中は削除ツールでは操作できません。')
    }
  }

  const stamp = stampOf(now)
  const stampDir = join(root, TRASH_DIR, stamp)
  const moved: TrashedItem[] = []
  for (const target of targets) {
    const rel = relative(root, target)
    const destination = join(stampDir, rel)
    const isFolder = statSync(target).isDirectory()
    const size = sizeOf(target)
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(target, destination)
    moved.push({ originalPath: target, trashPath: destination, isFolder, size_bytes: size })
  }
  const manifest: Manifest = {
    deletedAt: now.getTime(),
    items: moved.map((m) => ({
      path: relative(root, m.originalPath),
      isFolder: m.isFolder,
      size_bytes: m.size_bytes
    }))
  }
  writeFileSync(join(stampDir, MANIFEST), JSON.stringify(manifest, null, 1))
  return moved
}

export function listTrash(workRoot: string): TrashEntry[] {
  const trash = join(resolve(workRoot), TRASH_DIR)
  let stamps: string[]
  try {
    stamps = readdirSync(trash)
  } catch {
    return []
  }
  const entries: TrashEntry[] = []
  for (const stamp of stamps) {
    const manifest = readManifest(join(trash, stamp))
    if (!manifest) continue
    for (const item of manifest.items) {
      if (!existsSync(join(trash, stamp, item.path))) continue
      entries.push({
        id: join(stamp, item.path),
        root: resolve(workRoot),
        originalPath: item.path,
        deletedAt: manifest.deletedAt,
        isFolder: item.isFolder,
        size_bytes: item.size_bytes
      })
    }
  }
  return entries.sort((a, b) => b.deletedAt - a.deletedAt)
}

function removeFromManifest(stampDir: string, relPath: string): void {
  const manifest = readManifest(stampDir)
  if (!manifest) return
  manifest.items = manifest.items.filter((i) => i.path !== relPath)
  if (manifest.items.length === 0) rmSync(stampDir, { recursive: true, force: true })
  else writeFileSync(join(stampDir, MANIFEST), JSON.stringify(manifest, null, 1))
}

/**
 * 退避先から元の場所へ戻す（SEC-11）。同じ場所に別のファイルがある場合は戻さない
 */
export function restoreFromTrash(workRoot: string, entryId: string): string {
  const root = resolve(workRoot)
  const trash = join(root, TRASH_DIR)
  const source = resolve(trash, entryId)
  if (!isInsideWorkFolder(trash, source) || !existsSync(source)) {
    throw new ValidationError('退避したファイルが見つかりません。')
  }
  const [stamp, ...rest] = relative(trash, source).split(sep)
  const relPath = rest.join(sep)
  const destination = join(root, relPath)
  if (existsSync(destination)) {
    throw new ValidationError(`元の場所に同じ名前のファイルがあるため復元できません: ${relPath}`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  renameSync(source, destination)
  removeFromManifest(join(trash, stamp), relPath)
  return relPath
}

/** 退避した項目を元に戻す（Undo 用。パスで指定する） */
export function restoreTrashedPath(workRoot: string, trashPath: string): void {
  const trash = join(resolve(workRoot), TRASH_DIR)
  restoreFromTrash(workRoot, relative(trash, trashPath))
}

/**
 * 保持期間を過ぎた退避を完全に削除する（SEC-11: 画面でユーザーが確認してから呼ぶ）
 */
export function purgeTrash(workRoot: string, olderThanDays: number, now = Date.now()): number {
  const trash = join(resolve(workRoot), TRASH_DIR)
  let stamps: string[]
  try {
    stamps = readdirSync(trash)
  } catch {
    return 0
  }
  const limit = now - olderThanDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const stamp of stamps) {
    const manifest = readManifest(join(trash, stamp))
    if (!manifest || manifest.deletedAt > limit) continue
    rmSync(join(trash, stamp), { recursive: true, force: true })
    removed++
  }
  return removed
}
