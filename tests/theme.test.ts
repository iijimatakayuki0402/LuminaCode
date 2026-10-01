import { describe, expect, it } from 'vitest'
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_MODE, MODES } from '@shared/theme'

describe('theme settings', () => {
  it('提供するアクセントカラーは3色で、既定は水色', () => {
    expect(ACCENTS).toEqual(['purple', 'cyan', 'red'])
    expect(DEFAULT_ACCENT).toBe('cyan')
  })

  it('表示モードはダーク・ライト・標準で、既定は標準', () => {
    expect(MODES).toEqual(['dark', 'light', 'system'])
    expect(DEFAULT_MODE).toBe('system')
  })
})
