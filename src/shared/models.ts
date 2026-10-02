/**
 * モデル選択（要件 MDL-03、MDL-05）
 * モデル ID は固定で埋め込まず、Models API から取得した一覧から選ぶ。
 */

import type { ModelInfo } from './types'

/**
 * 使用するモデルを解決する（全体の既定 → プロジェクト → スレッド。下位が未設定なら上位を継承）
 */
export function resolveModel(
  defaultModel: string | null,
  projectModel: string | null,
  threadModel: string | null
): string | null {
  return threadModel ?? projectModel ?? defaultModel
}

/**
 * 初回の既定モデルを選ぶ（要件 MDL-05: 性能と価格のバランスが取れた中位モデル）
 * 中位の系統（Sonnet）のうち最も新しいものを選び、無ければ一覧で最も新しいモデルを選ぶ。
 * 系統名で判定し、特定のモデル ID には依存しない。
 */
export function pickDefaultModel(models: ModelInfo[]): string | null {
  const newestFirst = [...models].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const midTier = newestFirst.find((m) => m.id.toLowerCase().includes('sonnet'))
  return (midTier ?? newestFirst[0])?.id ?? null
}
