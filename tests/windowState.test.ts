import { describe, expect, it } from 'vitest'
import { DEFAULT_SIZE, parseWindowState, restoreBounds } from '../src/main/windowState'

const screen = { x: 0, y: 0, width: 1920, height: 1040 }

describe('ウィンドウの大きさ・位置（CMN-05）', () => {
  it('保存が無い・壊れている場合は既定の大きさ', () => {
    expect(parseWindowState(null)).toBeNull()
    expect(parseWindowState('{')).toBeNull()
    expect(parseWindowState('{"bounds":{"x":"1"}}')).toBeNull()
    expect(restoreBounds(null, [screen])).toEqual(DEFAULT_SIZE)
  })

  it('画面内なら前回の位置・大きさで開き、小さすぎる大きさは最小に合わせる', () => {
    const state = parseWindowState(
      JSON.stringify({ bounds: { x: 100, y: 50, width: 1400, height: 900 }, maximized: true })
    )
    expect(state?.maximized).toBe(true)
    expect(restoreBounds(state, [screen])).toEqual({ x: 100, y: 50, width: 1400, height: 900 })
    expect(
      restoreBounds({ bounds: { x: 10, y: 10, width: 100, height: 100 }, maximized: false }, [
        screen
      ])
    ).toEqual({ x: 10, y: 10, width: 800, height: 560 })
  })

  it('外したモニターの位置だった場合は、位置を指定しない（中央に開く）', () => {
    const state = { bounds: { x: 2500, y: 100, width: 1400, height: 900 }, maximized: false }
    expect(restoreBounds(state, [screen])).toEqual({ width: 1400, height: 900 })
    // 2 台目のモニターがあれば、そのまま開く
    const second = { x: 1920, y: 0, width: 2560, height: 1400 }
    expect(restoreBounds(state, [screen, second])).toMatchObject({ x: 2500, y: 100 })
    // 画面より大きければ、作業領域に収める
    const big = { bounds: { x: 5000, y: 0, width: 3000, height: 2000 }, maximized: false }
    expect(restoreBounds(big, [screen])).toEqual({ width: 1920, height: 1040 })
  })
})
