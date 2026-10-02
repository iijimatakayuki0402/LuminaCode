/**
 * 追加の作業フォルダ（要件 COW-12: 複数の作業フォルダ。読み取り専用の追加を含む）
 * プロジェクトの作業フォルダ（cwd）に加えて、フォルダごとに「読み取り専用」か「読み書き」を選んで追加できる。
 * 追加・変更・解除はいつでもでき、次の実行から反映する。
 * 書き込み・削除できるのは作業フォルダと「読み書き」のフォルダだけで、削除はそれぞれのフォルダの
 * .lumina-trash に退避する（SEC-10）。
 */

import type Database from 'better-sqlite3'
import { relative } from 'node:path'
import type { CoworkFolder, CoworkFolderAccess } from '@shared/types'
import { getSetting, setSetting, ValidationError } from '../db/operations'
import { isInsideWorkFolder } from '../security/pathGuard'
import { validateWorkFolder, type WorkFolderPolicy } from '../security/workFolder'

const KEY = (projectId: string): string => `cowork.folders.${projectId}`
export const EXTRA_FOLDERS_MAX = 10

export function listFolders(db: Database.Database, projectId: string): CoworkFolder[] {
  try {
    const list = JSON.parse(getSetting(db, KEY(projectId)) ?? '[]') as unknown
    return Array.isArray(list)
      ? list.filter(
          (f): f is CoworkFolder =>
            typeof f?.path === 'string' && (f?.access === 'read' || f?.access === 'write')
        )
      : []
  } catch {
    return []
  }
}

const overlaps = (a: string, b: string): boolean =>
  isInsideWorkFolder(a, b) || isInsideWorkFolder(b, a)

/** フォルダを追加する（作業フォルダと同じ検証を行い、実体パスで保存する） */
export function addFolder(
  db: Database.Database,
  projectId: string,
  workRoot: string,
  input: string,
  access: CoworkFolderAccess,
  policy: WorkFolderPolicy
): CoworkFolder[] {
  const path = validateWorkFolder(input, policy)
  if (overlaps(path, workRoot)) {
    throw new ValidationError(
      '作業フォルダと重なるフォルダ（作業フォルダの中、または作業フォルダを含むフォルダ）は追加できません。'
    )
  }
  const list = listFolders(db, projectId)
  if (list.some((f) => overlaps(f.path, path))) {
    throw new ValidationError('追加済みのフォルダと重なるフォルダは追加できません。')
  }
  if (list.length >= EXTRA_FOLDERS_MAX) {
    throw new ValidationError(`追加できるフォルダは ${EXTRA_FOLDERS_MAX} 件までです。`)
  }
  return write(db, projectId, [...list, { path, access }])
}

export function setFolderAccess(
  db: Database.Database,
  projectId: string,
  path: string,
  access: CoworkFolderAccess
): CoworkFolder[] {
  const list = listFolders(db, projectId)
  const target = list.find((f) => f.path === path)
  if (!target) throw new ValidationError('追加したフォルダが見つかりません。')
  target.access = access
  return write(db, projectId, list)
}

/** 解除する（フォルダ自体には触れない） */
export function removeFolder(
  db: Database.Database,
  projectId: string,
  path: string
): CoworkFolder[] {
  return write(
    db,
    projectId,
    listFolders(db, projectId).filter((f) => f.path !== path)
  )
}

function write(db: Database.Database, projectId: string, list: CoworkFolder[]): CoworkFolder[] {
  setSetting(db, KEY(projectId), JSON.stringify(list))
  return list
}

/** 実行時に使うフォルダ（書き込みできるフォルダ・読み取りだけのフォルダ） */
export interface FolderRoots {
  workRoot: string
  /** 作業フォルダ以外で書き込みできるフォルダ */
  writeRoots: string[]
  /** 読み取りだけを許すフォルダ */
  readRoots: string[]
}

export function rootsOf(db: Database.Database, projectId: string, workRoot: string): FolderRoots {
  const folders = listFolders(db, projectId)
  return {
    workRoot,
    writeRoots: folders.filter((f) => f.access === 'write').map((f) => f.path),
    readRoots: folders.filter((f) => f.access === 'read').map((f) => f.path)
  }
}

/** 画面・ログに出すパス（作業フォルダ内は相対パス、追加のフォルダは絶対パス） */
export function displayPath(workRoot: string, path: string): string {
  return isInsideWorkFolder(workRoot, path) ? relative(workRoot, path) || '.' : path
}

/** パスを含むフォルダ（最も深いもの）。どれにも含まれなければ null */
export function rootFor(roots: string[], path: string): string | null {
  return (
    roots.filter((root) => isInsideWorkFolder(root, path)).sort((a, b) => b.length - a.length)[0] ??
    null
  )
}
