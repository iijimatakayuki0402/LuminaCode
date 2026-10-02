/**
 * プロジェクトのテンプレート（要件 PRJ-09: プロジェクトをテンプレートとして保存し、新規作成時に選べる）
 * 種別・カスタム指示・モデル・権限モード・Web の設定を保存する。作業フォルダはプロジェクトごとに選ぶため含めない。
 */

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ProjectTemplate } from '@shared/types'
import { getCoworkSettings } from '../cowork/extensions'
import { getProject, getSetting, setSetting, ValidationError } from '../db/operations'

const KEY = 'project_templates'
export const TEMPLATE_NAME_MAX = 100
export const TEMPLATES_MAX = 100

export function listTemplates(db: Database.Database): ProjectTemplate[] {
  try {
    const list = JSON.parse(getSetting(db, KEY) ?? '[]') as unknown
    return Array.isArray(list)
      ? list.filter(
          (t): t is ProjectTemplate =>
            typeof t?.id === 'string' &&
            typeof t?.name === 'string' &&
            (t?.type === 'chat' || t?.type === 'cowork')
        )
      : []
  } catch {
    return []
  }
}

/** プロジェクトの今の設定をテンプレートとして保存する（同じ名前があれば上書きする） */
export function saveTemplateFromProject(
  db: Database.Database,
  projectId: string,
  name: string
): ProjectTemplate[] {
  const project = getProject(db, projectId)
  if (!project) throw new ValidationError('プロジェクトが見つかりません。')
  const trimmed = name.trim()
  if (trimmed === '') throw new ValidationError('テンプレートの名前を入力してください。')
  if ([...trimmed].length > TEMPLATE_NAME_MAX) {
    throw new ValidationError(
      `テンプレートの名前は ${TEMPLATE_NAME_MAX} 文字以内で入力してください。`
    )
  }
  const list = listTemplates(db)
  const existing = list.find((t) => t.name === trimmed)
  if (!existing && list.length >= TEMPLATES_MAX) {
    throw new ValidationError(`テンプレートは ${TEMPLATES_MAX} 件まで保存できます。`)
  }
  const template: ProjectTemplate = {
    id: existing?.id ?? randomUUID(),
    name: trimmed,
    type: project.type,
    custom_instructions: project.custom_instructions,
    model: project.model,
    permission_mode: project.type === 'cowork' ? project.permission_mode : null,
    web_access: getCoworkSettings(db, project.id).webAccess
  }
  return write(db, [...list.filter((t) => t.id !== template.id), template])
}

export function deleteTemplate(db: Database.Database, id: string): ProjectTemplate[] {
  return write(
    db,
    listTemplates(db).filter((t) => t.id !== id)
  )
}

function write(db: Database.Database, list: ProjectTemplate[]): ProjectTemplate[] {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  setSetting(db, KEY, JSON.stringify(sorted))
  return sorted
}
