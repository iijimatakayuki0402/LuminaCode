import { describe, expect, it } from 'vitest'
import { estimateCost, findPrice } from '../../src/main/chat/pricing'

const usage = (input: number, output: number, write = 0, read = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read
})

describe('pricing（USG-01）', () => {
  it('最も長く一致する単価を使う', () => {
    expect(findPrice('claude-opus-5-5')?.input).toBe(4)
    expect(findPrice('claude-opus-5')?.input).toBe(5)
    expect(findPrice('claude-haiku-4-5-20251001')?.input).toBe(1)
    expect(findPrice('claude-sonnet-4-5-20250929')?.input).toBe(3)
  })

  it('入力・出力・キャッシュの書き込み・読み込みを合算する', () => {
    // Sonnet 5.5: $2 / $10 / 書き込み $2.5 / 読み込み $0.2（100 万トークンあたり）
    expect(
      estimateCost('claude-sonnet-5-5', usage(1_000_000, 100_000, 200_000, 500_000))
    ).toBeCloseTo(2 + 1 + 0.5 + 0.1, 6)
  })

  it('単価が不明なモデルは null', () => {
    expect(estimateCost('unknown-model', usage(1, 1))).toBeNull()
    expect(findPrice('claude-opus-55')).toBeNull()
  })
})
