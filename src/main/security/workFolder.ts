/**
 * 作業フォルダとして指定できるかの検証（要件 PRJ-05、PRJ-06）
 * 拒否する対象: ドライブ（共有）のルート、Windows フォルダ、Program Files*、
 * ユーザーフォルダそのもの（とその親の Users）、アプリのデータ保存先（の内側・外側とも）。
 * 判定はリンク・8.3 短縮名を解決した実体パスで行う。
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import { ValidationError } from '../db/operations'

export interface WorkFolderPolicy {
  /** アプリのデータ保存先（%APPDATA%\LuminaCode） */
  userDataPath: string
  /** ユーザーフォルダ（C:\Users\<名前>） */
  homeDir: string
  /** Windows フォルダ（%SystemRoot%） */
  systemRoot: string
}

const normalizeCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

function real(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** a が b と同じか、b の内側にあるか */
function isSameOrInside(a: string, b: string): boolean {
  const rel = relative(normalizeCase(b), normalizeCase(a))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const same = (a: string, b: string): boolean => normalizeCase(a) === normalizeCase(b)

/** 同じドライブ直下の Program Files で始まるフォルダ（Program Files、Program Files (x86) など） */
function programFilesDirs(driveRoot: string): string[] {
  try {
    return readdirSync(driveRoot)
      .filter((name) => name.toLowerCase().startsWith('program files'))
      .map((name) => join(driveRoot, name))
  } catch {
    return []
  }
}

/**
 * 作業フォルダを検証し、実体パスを返す。指定できない場合は ValidationError を投げる
 */
export function validateWorkFolder(input: string, policy: WorkFolderPolicy): string {
  if (!isAbsolute(input) || input.includes('\0')) {
    throw new ValidationError('作業フォルダは絶対パスで指定してください。')
  }

  let isDirectory = false
  try {
    isDirectory = statSync(input).isDirectory()
  } catch {
    // 存在しない
  }
  if (!isDirectory) {
    throw new ValidationError('作業フォルダが見つかりません。存在するフォルダを指定してください。')
  }

  const folder = real(input)
  const reject = (reason: string): never => {
    throw new ValidationError(`このフォルダは作業フォルダに指定できません（${reason}）。`)
  }

  const root = parse(folder).root
  if (same(folder, root)) reject('ドライブのルート')

  if (isSameOrInside(folder, real(policy.systemRoot))) reject('Windows のシステムフォルダ')

  for (const dir of programFilesDirs(root)) {
    if (isSameOrInside(folder, real(dir))) reject('Program Files')
  }

  const home = real(policy.homeDir)
  if (same(folder, home) || same(folder, dirname(home))) reject('ユーザーフォルダそのもの')

  // データ保存先の内側はもちろん、データ保存先を含むフォルダも、DB や API キーを操作できてしまうため拒否する
  const userData = real(policy.userDataPath)
  if (isSameOrInside(folder, userData) || isSameOrInside(userData, folder)) {
    reject('アプリのデータ保存先')
  }

  return folder
}
