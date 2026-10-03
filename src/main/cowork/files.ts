/**
 * 作業フォルダのファイルツリーとプレビュー（要件 COW-08: 読み取り専用）
 * 対象は作業フォルダの中に限る（SEC-01〜02 と同じ境界の判定を通す）。リンクはたどらない。
 */

import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import type { FileEntry, FilePreview } from '@shared/types'
import { ValidationError } from '../db/operations'
import { isInsideWorkFolder } from '../security/pathGuard'

export const MAX_ENTRIES = 2000
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function resolveInside(workRoot: string, relPath: string): string {
  const target = resolve(workRoot, relPath || '.')
  if (!isInsideWorkFolder(workRoot, target)) {
    throw new ValidationError('作業フォルダの外は表示できません。')
  }
  return target
}

/** フォルダの中身（フォルダが先、名前順） */
export function listDir(workRoot: string, relPath: string): FileEntry[] {
  const dir = resolveInside(workRoot, relPath)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    throw new ValidationError('フォルダを開けません。')
  }
  const entries: FileEntry[] = []
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const full = join(dir, name)
    try {
      const link = lstatSync(full)
      const isLink = link.isSymbolicLink()
      const stat = isLink ? link : statSync(full)
      entries.push({
        name,
        path: relative(workRoot, full),
        isDir: !isLink && stat.isDirectory(),
        isLink,
        size_bytes: stat.isDirectory() ? 0 : stat.size,
        modified_at: stat.mtimeMs
      })
    } catch {
      // 読めないものは表示しない
    }
  }
  return entries.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'ja')
  )
}

/** ファイルのプレビュー（テキストは先頭だけ、画像はデータ URL） */
export function readPreview(workRoot: string, relPath: string): FilePreview {
  const file = resolveInside(workRoot, relPath)
  const stat = statSync(file)
  if (!stat.isFile()) throw new ValidationError('ファイルではありません。')
  const path = relative(workRoot, file)
  const mime = IMAGE_TYPES[extname(file).toLowerCase()]
  if (mime) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { path, kind: 'unsupported', size_bytes: stat.size, truncated: false }
    }
    return {
      path,
      kind: 'image',
      dataUrl: `data:${mime};base64,${readFileSync(file).toString('base64')}`,
      size_bytes: stat.size,
      truncated: false
    }
  }
  // 大きなファイルでも先頭だけを読む
  const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES))
  const fd = openSync(file, 'r')
  let length: number
  try {
    length = readSync(fd, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(fd)
  }
  const bytes = buffer.subarray(0, length)
  // 先頭に NUL を含むものはバイナリとみなす
  if (bytes.subarray(0, 8000).includes(0)) {
    return { path, kind: 'unsupported', size_bytes: stat.size, truncated: false }
  }
  // 末尾で文字が切れていても表示できるよう、置き換え文字を許す
  const text = new TextDecoder('utf-8').decode(bytes)
  return { path, kind: 'text', text, size_bytes: stat.size, truncated: stat.size > MAX_TEXT_BYTES }
}
