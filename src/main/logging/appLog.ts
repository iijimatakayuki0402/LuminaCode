/**
 * アプリログ（要件 6.14、10.2: エラー・API 呼び出しの成否を記録する。会話内容・API キー・ファイル内容は出力しない）
 * main プロセスの console.info / console.warn / console.error をファイルにも書き出す。
 * ログを出す側は、種別・ステータス・エラー名など内容を含まない情報だけを渡す。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

export const MAX_LOG_BYTES = 5 * 1024 * 1024
export const LOG_GENERATIONS = 3

/** API キーなどの秘密情報らしい文字列を伏せる（SEC-31） */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(
      /(x-api-key|authorization|api[_-]?key)(["':=\s]+)((?:Bearer\s+)?[^\s"',}]+)/gi,
      '$1$2***'
    )
}

function rotate(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_LOG_BYTES) return
    rmSync(`${file}.${LOG_GENERATIONS}`, { force: true })
    for (let i = LOG_GENERATIONS - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    }
    renameSync(file, `${file}.1`)
  } catch {
    // 交代に失敗しても書き込みは続ける
  }
}

export function writeLog(file: string, level: string, args: unknown[]): void {
  const message = args
    .map((a) =>
      a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : format('%o', a)
    )
    .join(' ')
  rotate(file)
  appendFileSync(file, `${new Date().toISOString()} [${level}] ${redact(message)}\n`)
}

/**
 * アプリログを削除する（6.12。交代した古い世代も含む）。次の書き込みで新しいファイルを作る
 */
export function clearAppLog(file: string): void {
  rmSync(file, { force: true })
  for (let i = 1; i <= LOG_GENERATIONS; i++) rmSync(`${file}.${i}`, { force: true })
}

/**
 * console.info / console.warn / console.error をログファイルにも書き出す。戻り値はログファイルのパス
 */
export function installAppLog(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'app.log')
  for (const level of ['info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      try {
        writeLog(file, level.toUpperCase(), args)
      } catch {
        // ログの失敗でアプリを止めない
      }
    }
  }
  return file
}
