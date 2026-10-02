/**
 * カスタム指示（要件 PRJ-08: 全プロジェクト共通の指示を、プロジェクトの指示と結合して適用する。順序はグローバル → プロジェクト）
 */

import type Database from 'better-sqlite3'
import { deleteSetting, getSetting, setSetting, ValidationError } from '../db/operations'

const KEY = 'instructions.global'
export const GLOBAL_INSTRUCTIONS_MAX = 20000

export function getGlobalInstructions(db: Database.Database): string {
  return getSetting(db, KEY) ?? ''
}

export function setGlobalInstructions(db: Database.Database, text: string): string {
  if ([...text].length > GLOBAL_INSTRUCTIONS_MAX) {
    throw new ValidationError(
      `共通のカスタム指示は ${GLOBAL_INSTRUCTIONS_MAX.toLocaleString()} 文字以内で入力してください。`
    )
  }
  if (text.trim() === '') deleteSetting(db, KEY)
  else setSetting(db, KEY, text)
  return getGlobalInstructions(db)
}

/**
 * システムプロンプトに入れる指示（グローバル → プロジェクト → 要約の順）
 */
export function combineInstructions(
  global: string,
  project: string | null,
  summary?: string | null
): string | null {
  const parts: string[] = []
  if (global.trim()) parts.push(`# 共通のカスタム指示\n${global.trim()}`)
  if (project?.trim()) parts.push(`# プロジェクトのカスタム指示\n${project.trim()}`)
  if (summary?.trim()) {
    parts.push(
      `# これまでの会話の要約\nこのスレッドは、以前の会話を要約して続けています。必要に応じて参照してください。\n\n${summary.trim()}`
    )
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}
