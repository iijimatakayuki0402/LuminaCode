/**
 * 拒否されたときのフォールバック（要件 CHT-16）
 * サーバー側のフォールバック（fallbacks: "default"）を使う。拒否の種類に応じて、Anthropic が推奨する
 * モデルで同じリクエストを回答し直す。対応しないモデルは Models API からは分からないため、
 * 実際に送って確かめ、受け付けられなかったモデルを覚えておく（thinking.ts と同じ方式。400 は課金されない）。
 */

import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { getSetting, setSetting } from '../db/operations'
import type { TokenUsage } from './pricing'

/** fallbacks: "default" の形に対応するベータ（配列の形は別のベータで、組み合わせを間違えると 400 になる） */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

const KEY = (model: string): string => `fallback.unsupported.${model}`

export function supportsFallback(db: Database.Database, model: string): boolean {
  return getSetting(db, KEY(model)) === null
}

export function rememberFallbackUnsupported(db: Database.Database, model: string): void {
  setSetting(db, KEY(model), '1')
}

/** fallbacks の指定がモデルに受け付けられなかったエラーか */
export function isFallbackConfigError(error: unknown): boolean {
  return error instanceof Anthropic.BadRequestError && /fallback/i.test(error.message)
}

type Block = { type: string; id?: string; tool_use_id?: string }

/**
 * 保存した回答を、次のリクエストで送り返せる形にする
 * 途中で切り替わった回答は、最後の fallback ブロックより前にある思考・ツール呼び出し・結果の無い
 * サーバーツール呼び出しを送らない（それらは切り替わる前のモデルのもので、検証できないため）。
 * fallback ブロック自体は記録用の印のため、送らない
 */
export function echoBlocks<T extends Block>(blocks: T[]): T[] {
  const boundary = blocks.map((b) => b.type).lastIndexOf('fallback')
  if (boundary < 0) return blocks
  const answered = new Set(blocks.filter((b) => b.tool_use_id).map((b) => b.tool_use_id))
  return blocks.filter((b, i) => {
    if (b.type === 'fallback') return false
    if (i > boundary) return true
    if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use') {
      return false
    }
    if (b.type === 'server_tool_use') return answered.has(b.id)
    return true
  })
}

/** 回答が別のモデルに切り替わったか（最初に拒否したモデルと、最後に回答したモデル） */
export function fallbackOf(contentBlocks: string | null): { from: string; to: string } | null {
  if (!contentBlocks) return null
  try {
    const blocks = (JSON.parse(contentBlocks) as unknown[]).filter(
      (b): b is { type: 'fallback'; from: { model: string }; to: { model: string } } =>
        (b as { type?: unknown })?.type === 'fallback'
    )
    if (blocks.length === 0) return null
    return { from: blocks[0].from.model, to: blocks[blocks.length - 1].to.model }
  } catch {
    return null
  }
}

export interface ModelUsage {
  model: string
  usage: TokenUsage
}

type Usage = Anthropic.Beta.BetaUsage

/**
 * 応答の使用量をモデルごとに分ける
 * フォールバックした場合、上位の usage は回答したモデルの分だけのため、試行ごとの記録（iterations）を使う
 */
export function splitUsage(
  final: { model?: string | null; usage: Usage },
  requested: string
): ModelUsage[] {
  const served = final.model || requested
  const searches = final.usage.server_tool_use?.web_search_requests ?? 0
  const iterations = final.usage.iterations ?? []
  if (!iterations.some((i) => i.type === 'fallback_message')) {
    return [
      {
        model: served,
        usage: {
          input_tokens: final.usage.input_tokens,
          output_tokens: final.usage.output_tokens,
          cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
          web_search_requests: searches
        }
      }
    ]
  }
  const byModel = new Map<string, TokenUsage>()
  for (const i of iterations) {
    if (i.type !== 'message' && i.type !== 'fallback_message') continue
    const model = i.model || requested
    const sum = byModel.get(model) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      web_search_requests: 0
    }
    sum.input_tokens += i.input_tokens
    sum.output_tokens += i.output_tokens
    sum.cache_creation_input_tokens += i.cache_creation_input_tokens
    sum.cache_read_input_tokens += i.cache_read_input_tokens
    byModel.set(model, sum)
  }
  // Web 検索の回数は試行ごとには分からないため、回答したモデルの分として数える
  const entries = [...byModel].map(([model, usage]) => ({ model, usage }))
  const servedEntry = entries.find((e) => e.model === served) ?? entries.at(-1)
  if (servedEntry) servedEntry.usage.web_search_requests = searches
  return entries
}
