/**
 * モデル一覧と既定モデル（要件 MDL-01〜05）
 * 一覧は Models API から取得し、DB（settings）にキャッシュする。取得に失敗した場合はキャッシュを返す。
 */

import type Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { pickDefaultModel } from '@shared/models'
import type { ModelInfo, ModelList } from '@shared/types'
import { toApiRequestError } from '../api/errors'
import { getSetting, setSetting, ValidationError } from '../db/operations'

export const MODELS_CACHE_KEY = 'models_cache'
export const DEFAULT_MODEL_KEY = 'default_model'

/** キャッシュをそのまま使う期間（これより古ければ取得し直す） */
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface ModelsCache {
  fetched_at: number
  models: ModelInfo[]
}

/**
 * Models API から全件取得する（ページングは SDK が自動で行う）
 */
export async function fetchModels(client: Anthropic): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  for await (const m of client.models.list({ limit: 100 })) {
    models.push({
      id: m.id,
      display_name: m.display_name,
      created_at: m.created_at,
      max_input_tokens: m.max_input_tokens ?? null,
      max_tokens: m.max_tokens ?? null,
      supports_adaptive_thinking: m.capabilities?.thinking?.types?.adaptive?.supported ?? false
    })
  }
  return models
}

function readCache(db: Database.Database): ModelsCache | null {
  const raw = getSetting(db, MODELS_CACHE_KEY)
  if (raw === null) return null
  try {
    const cache = JSON.parse(raw) as ModelsCache
    if (!Array.isArray(cache.models) || typeof cache.fetched_at !== 'number') return null
    // 項目が足りない古い形式のキャッシュは、取得し直すまでの間だけ使う
    const complete = cache.models.every((m) => typeof m.supports_adaptive_thinking === 'boolean')
    return complete ? cache : { ...cache, fetched_at: 0 }
  } catch {
    return null
  }
}

export class ModelService {
  constructor(
    private readonly db: Database.Database,
    private readonly getClient: () => Anthropic | null,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * モデル一覧を返す
   * refresh=false ではキャッシュが新しければ API を呼ばない。
   * API の呼び出しに失敗した場合、キャッシュがあれば stale として返し、無ければエラーを投げる。
   */
  async list(refresh = false): Promise<ModelList> {
    const cache = readCache(this.db)
    if (!refresh && cache && this.now() - cache.fetched_at < MODELS_CACHE_TTL_MS) {
      return { models: cache.models, fetched_at: cache.fetched_at, stale: false }
    }

    const client = this.getClient()
    if (!client) {
      return { models: cache?.models ?? [], fetched_at: cache?.fetched_at ?? null, stale: true }
    }

    try {
      const models = await fetchModels(client)
      const fetchedAt = this.now()
      setSetting(this.db, MODELS_CACHE_KEY, JSON.stringify({ fetched_at: fetchedAt, models }))
      this.ensureDefaultModel(models)
      return { models, fetched_at: fetchedAt, stale: false }
    } catch (error) {
      const apiError = toApiRequestError(error, 'models.list')
      if (!cache) throw apiError
      return { models: cache.models, fetched_at: cache.fetched_at, stale: true }
    }
  }

  /** キャッシュ済みのモデル情報（チャットのリクエスト組み立て用） */
  getModelInfo(modelId: string): ModelInfo | null {
    return readCache(this.db)?.models.find((m) => m.id === modelId) ?? null
  }

  getDefaultModel(): string | null {
    return getSetting(this.db, DEFAULT_MODEL_KEY)
  }

  /**
   * 既定モデルを設定する。取得済みの一覧にあるモデルのみ指定できる
   */
  setDefaultModel(modelId: string): void {
    const models = readCache(this.db)?.models ?? []
    if (!models.some((m) => m.id === modelId)) {
      throw new ValidationError('選択したモデルが一覧にありません。モデル一覧を更新してください。')
    }
    setSetting(this.db, DEFAULT_MODEL_KEY, modelId)
  }

  /** 既定モデルが未設定、または一覧から消えた場合に中位モデルを設定する（要件 MDL-05） */
  private ensureDefaultModel(models: ModelInfo[]): void {
    const current = this.getDefaultModel()
    if (current !== null && models.some((m) => m.id === current)) return
    const picked = pickDefaultModel(models)
    if (picked !== null) setSetting(this.db, DEFAULT_MODEL_KEY, picked)
  }
}
