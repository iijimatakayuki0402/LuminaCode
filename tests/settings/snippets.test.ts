import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { deleteSnippet, listSnippets, saveSnippet } from '../../src/main/settings/snippets'

let db: Database.Database
beforeEach(() => {
  db = createInMemoryDatabase()
})
afterEach(() => db.close())

describe('スニペット（CHT-12）', () => {
  it('追加・更新・削除し、名前順に並べる', () => {
    saveSnippet(db, { name: '要約', content: '3 行で要約して' })
    const list = saveSnippet(db, { name: ' 敬語 ', content: '敬語に直して' })
    expect(list.map((s) => s.name)).toEqual(['敬語', '要約'])

    const target = list.find((s) => s.name === '要約')!
    const updated = saveSnippet(db, { id: target.id, name: '要約', content: '5 行で' })
    expect(updated.find((s) => s.id === target.id)?.content).toBe('5 行で')
    expect(listSnippets(db)).toHaveLength(2)

    expect(deleteSnippet(db, target.id).map((s) => s.name)).toEqual(['敬語'])
  })

  it('名前・内容の空欄、長すぎる値、同じ名前、知らない ID は保存しない', () => {
    saveSnippet(db, { name: 'A', content: 'x' })
    expect(() => saveSnippet(db, { name: ' ', content: 'x' })).toThrow('名前')
    expect(() => saveSnippet(db, { name: 'B', content: '  ' })).toThrow('内容')
    expect(() => saveSnippet(db, { name: 'あ'.repeat(51), content: 'x' })).toThrow('50')
    expect(() => saveSnippet(db, { name: 'B', content: 'x'.repeat(20001) })).toThrow('20,000')
    expect(() => saveSnippet(db, { name: 'A', content: 'y' })).toThrow('同じ名前')
    expect(() => saveSnippet(db, { id: 'nope', name: 'C', content: 'y' })).toThrow('見つかりません')
  })

  it('壊れた保存内容は空の一覧として扱う', () => {
    ops.setSetting(db, 'snippets', '{')
    expect(listSnippets(db)).toEqual([])
    ops.setSetting(
      db,
      'snippets',
      JSON.stringify([{ id: 1 }, { id: 'a', name: 'n', content: 'c' }])
    )
    expect(listSnippets(db)).toEqual([{ id: 'a', name: 'n', content: 'c' }])
  })
})
