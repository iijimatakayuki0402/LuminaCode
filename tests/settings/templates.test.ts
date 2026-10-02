import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { setCoworkSettings } from '../../src/main/cowork/extensions'
import {
  deleteTemplate,
  listTemplates,
  saveTemplateFromProject
} from '../../src/main/settings/templates'

let db: Database.Database
beforeEach(() => {
  db = createInMemoryDatabase()
})
afterEach(() => db.close())

describe('プロジェクトのテンプレート（PRJ-09）', () => {
  it('種別・指示・モデル・権限モード・Web の設定を保存し、作業フォルダは含めない', () => {
    const p = ops.createProject(db, {
      type: 'cowork',
      name: 'レビュー',
      work_folder: String.raw`C:\work`,
      custom_instructions: '厳しめに',
      model: 'claude-x',
      permission_mode: 'plan_only'
    })
    setCoworkSettings(db, p.id, { webAccess: true })
    const [t] = saveTemplateFromProject(db, p.id, ' レビュー用 ')
    expect(t).toEqual({
      id: expect.any(String),
      name: 'レビュー用',
      type: 'cowork',
      custom_instructions: '厳しめに',
      model: 'claude-x',
      permission_mode: 'plan_only',
      web_access: true
    })
    expect(JSON.stringify(t)).not.toContain('C:')
    expect(t).not.toHaveProperty('work_folder')
  })

  it('同じ名前は上書きし、名前順に並べ、削除できる', () => {
    const a = ops.createProject(db, { type: 'chat', name: 'A', custom_instructions: '1' })
    const b = ops.createProject(db, { type: 'chat', name: 'B', custom_instructions: '2' })
    saveTemplateFromProject(db, a.id, 'い')
    saveTemplateFromProject(db, b.id, 'あ')
    const list = saveTemplateFromProject(db, b.id, 'い')
    expect(list.map((t) => [t.name, t.custom_instructions])).toEqual([
      ['あ', '2'],
      ['い', '2']
    ])
    expect(list.find((t) => t.name === 'い')?.permission_mode).toBeNull()
    expect(deleteTemplate(db, list[0].id).map((t) => t.name)).toEqual(['い'])
    expect(listTemplates(db)).toHaveLength(1)
  })

  it('名前が空・長すぎる、プロジェクトが無い場合は保存しない', () => {
    const p = ops.createProject(db, { type: 'chat', name: 'A' })
    expect(() => saveTemplateFromProject(db, p.id, ' ')).toThrow('名前')
    expect(() => saveTemplateFromProject(db, p.id, 'x'.repeat(101))).toThrow('100')
    expect(() => saveTemplateFromProject(db, 'nope', 'x')).toThrow('見つかりません')
  })
})
