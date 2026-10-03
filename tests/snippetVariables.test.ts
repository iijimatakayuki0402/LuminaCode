import { describe, expect, it } from 'vitest'
import { fillSnippet, snippetVariables } from '../src/shared/snippetVariables'

describe('スニペットの変数（CHT-15）', () => {
  it('出てくる順に、重複を除いて取り出す（前後の空白は無視する）', () => {
    expect(snippetVariables('{{対象}}を{{ 言語 }}に翻訳。{{対象}}の要点も')).toEqual([
      '対象',
      '言語'
    ])
    expect(snippetVariables('変数なし { 単独 } {{}} {{\n改行}}')).toEqual([])
  })

  it('同じ名前はまとめて置き換え、値の中の {{ }} は展開し直さない', () => {
    expect(
      fillSnippet('{{対象}}を{{ 言語 }}に。{{対象}}', { 対象: '{{言語}}', 言語: '英語' })
    ).toBe('{{言語}}を英語に。{{言語}}')
    expect(fillSnippet('{{a}}と{{b}}', { a: 'x' })).toBe('xと')
  })
})
