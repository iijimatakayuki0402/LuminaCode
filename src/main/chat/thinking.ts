/**
 * 拡張思考のオン／オフ（要件 CHT-07）
 * 思考を止める指定はモデルによって異なる（`disabled` を受け付けるモデル、`between_tools` を使うモデル、
 * 止められないモデルがある）。Models API からは分からず、モデル ID を埋め込むこともしないため、
 * 実際に送って確かめ、受け付けられた指定をモデルごとに覚えておく（400 のリクエストは課金されない）。
 */

import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import type { EffortLevel } from '@shared/types'
import { getSetting, setSetting } from '../db/operations'

export const THINKING_BETA = 'thinking-binding-controls-2026-08-01'

/** on: 思考あり（adaptive）／none: 思考に対応しないモデル／それ以外: 思考を止める指定 */
export type ThinkingMode = 'on' | 'none' | 'disabled' | 'between_tools'
type OffMode = 'disabled' | 'between_tools'

const KEY = (model: string): string => `thinking.off.${model}`

/**
 * 思考を止めるときに試す指定（覚えている指定があればそれだけ）。止められないと分かっているモデルは空
 * `between_tools` は思考量が xhigh・max のときは使えない
 */
export function offCandidates(
  db: Database.Database,
  model: string,
  effort: EffortLevel | null
): OffMode[] {
  const learned = getSetting(db, KEY(model))
  if (learned === 'unsupported') return []
  const highEffort = effort === 'xhigh' || effort === 'max'
  const all: OffMode[] = highEffort ? ['disabled'] : ['disabled', 'between_tools']
  return learned === 'disabled' || learned === 'between_tools'
    ? all.filter((m) => m === learned)
    : all
}

export function rememberOffMode(
  db: Database.Database,
  model: string,
  mode: OffMode | 'unsupported'
): void {
  if (getSetting(db, KEY(model)) !== mode) setSetting(db, KEY(model), mode)
}

/** リクエストの thinking・betas の指定 */
export function thinkingParams(
  mode: ThinkingMode
): Pick<Anthropic.Beta.MessageCreateParamsStreaming, 'thinking' | 'betas'> {
  if (mode === 'on') {
    return {
      thinking: {
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      },
      betas: [THINKING_BETA]
    }
  }
  if (mode === 'disabled') return { thinking: { type: 'disabled' } }
  if (mode === 'between_tools') return { thinking: { type: 'between_tools' } }
  return {}
}

/** 思考の指定がモデルに受け付けられなかったエラーか */
export function isThinkingConfigError(error: unknown): boolean {
  return error instanceof Anthropic.BadRequestError && /thinking/i.test(error.message)
}
