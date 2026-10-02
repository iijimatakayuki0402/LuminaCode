import { describe, expect, it } from 'vitest'
import { SHORTCUTS, shortcutFor, type KeyInput } from '@shared/shortcuts'

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods
})

describe('キーボードショートカット（CMN-02）', () => {
  it('要件の表のキーに対応する', () => {
    expect(shortcutFor(key('n', { ctrlKey: true }))).toBe('newThread')
    // Shift を押すと key は大文字になる
    expect(shortcutFor(key('N', { ctrlKey: true, shiftKey: true }))).toBe('newProject')
    expect(shortcutFor(key('k', { ctrlKey: true }))).toBe('search')
    expect(shortcutFor(key(',', { ctrlKey: true }))).toBe('settings')
    expect(shortcutFor(key('Escape'))).toBe('stop')
  })

  it('CapsLock で大文字になっていても同じ', () => {
    expect(shortcutFor(key('N', { ctrlKey: true }))).toBe('newThread')
    expect(shortcutFor(key('K', { ctrlKey: true }))).toBe('search')
  })

  it('修飾キーが違う場合は扱わない', () => {
    expect(shortcutFor(key('n'))).toBeNull()
    expect(shortcutFor(key('k', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(shortcutFor(key('k', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(shortcutFor(key('n', { ctrlKey: true, metaKey: true }))).toBeNull()
    expect(shortcutFor(key('Escape', { shiftKey: true }))).toBeNull()
    expect(shortcutFor(key('Escape', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(key('c', { ctrlKey: true }))).toBeNull()
  })

  it('日本語入力の変換中は扱わない', () => {
    expect(shortcutFor(key('Escape', { isComposing: true }))).toBeNull()
    expect(shortcutFor(key('n', { ctrlKey: true, isComposing: true }))).toBeNull()
  })

  it('一覧の操作はすべて判定できる', () => {
    expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length)
  })
})
