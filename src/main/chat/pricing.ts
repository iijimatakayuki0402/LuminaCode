/**
 * 概算コスト（要件 USG-01、USG-05: 単価表に基づく概算で、実際の請求額とは異なる）
 * 単価は USD / 100 万トークン。モデル ID の前方一致で引く（日付付きの ID にも対応する）。
 * 単価表の外部ファイルでの更新（USG-05）は Stage 7 で対応する。
 */

export interface ModelPrice {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

// Anthropic の公開価格（2026-09-25 時点）。キャッシュ書き込みは 5 分 TTL の単価（入力の 1.25 倍）
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/** 最も長く一致する単価を返す（例: claude-opus-5-5 は claude-opus-5 より優先） */
export function findPrice(
  model: string,
  prices: Record<string, ModelPrice> = DEFAULT_PRICES
): ModelPrice | null {
  const key = Object.keys(prices)
    .filter((prefix) => model === prefix || model.startsWith(`${prefix}-`))
    .sort((a, b) => b.length - a.length)[0]
  return key ? prices[key] : null
}

/**
 * 概算コスト（USD）。単価が不明なモデルは null
 */
export function estimateCost(
  model: string,
  usage: TokenUsage,
  prices: Record<string, ModelPrice> = DEFAULT_PRICES
): number | null {
  const price = findPrice(model, prices)
  if (!price) return null
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_creation_input_tokens * price.cacheWrite +
      usage.cache_read_input_tokens * price.cacheRead) /
    1_000_000
  )
}
