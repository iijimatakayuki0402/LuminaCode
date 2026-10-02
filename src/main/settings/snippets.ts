/**
 * 定型プロンプト（スニペット。要件 CHT-12: 保存しておき、入力欄から呼び出す）
 * 全プロジェクト共通。設定に JSON として保存する。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Snippet, SnippetInput } from '@shared/types'
import { getSetting, setSetting, ValidationError } from '../db/operations'

const KEY = 'snippets'
export const SNIPPET_NAME_MAX = 50
export const SNIPPET_CONTENT_MAX = 20000
export const SNIPPETS_MAX = 200

export function listSnippets(db: Database.Database): Snippet[] {
  try {
    const list = JSON.parse(getSetting(db, KEY) ?? '[]') as unknown
    return Array.isArray(list)
      ? list.filter(
          (s): s is Snippet =>
            typeof s?.id === 'string' &&
            typeof s?.name === 'string' &&
            typeof s?.content === 'string'
        )
      : []
  } catch {
    return []
  }
}

/** 追加（id なし）または更新して、並べ替えた一覧を返す */
export function saveSnippet(db: Database.Database, input: SnippetInput): Snippet[] {
  const name = input.name.trim()
  if (name === '') throw new ValidationError('スニペットの名前を入力してください。')
  if ([...name].length > SNIPPET_NAME_MAX) {
    throw new ValidationError(`スニペットの名前は ${SNIPPET_NAME_MAX} 文字以内で入力してください。`)
  }
  if (input.content.trim() === '') throw new ValidationError('スニペットの内容を入力してください。')
  if ([...input.content].length > SNIPPET_CONTENT_MAX) {
    throw new ValidationError(
      `スニペットの内容は ${SNIPPET_CONTENT_MAX.toLocaleString()} 文字以内で入力してください。`
    )
  }
  const list = listSnippets(db)
  if (list.some((s) => s.name === name && s.id !== input.id)) {
    throw new ValidationError('同じ名前のスニペットがあります。')
  }
  if (input.id) {
    const target = list.find((s) => s.id === input.id)
    if (!target) throw new ValidationError('スニペットが見つかりません。')
    target.name = name
    target.content = input.content
  } else {
    if (list.length >= SNIPPETS_MAX) {
      throw new ValidationError(`スニペットは ${SNIPPETS_MAX} 件まで保存できます。`)
    }
    list.push({ id: randomUUID(), name, content: input.content })
  }
  return write(db, list)
}

export function deleteSnippet(db: Database.Database, id: string): Snippet[] {
  return write(
    db,
    listSnippets(db).filter((s) => s.id !== id)
  )
}

function write(db: Database.Database, list: Snippet[]): Snippet[] {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  setSetting(db, KEY, JSON.stringify(sorted))
  return sorted
}
