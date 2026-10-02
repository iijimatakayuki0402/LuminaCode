import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryDatabase } from '../../src/main/db/init'
import { ValidationError } from '../../src/main/db/operations'
import { ApiRequestError } from '../../src/main/api/errors'
import { MODELS_CACHE_TTL_MS, ModelService } from '../../src/main/models/modelService'
import { pickDefaultModel, resolveModel } from '../../src/shared/models'
import type { ModelInfo } from '../../src/shared/types'
import { apiError, fakeClient, type FakeModel } from '../helpers/fakeAnthropic'

const MODELS: FakeModel[] = [
  { id: 'claude-haiku-x', created_at: '2025-10-01T00:00:00Z' },
  { id: 'claude-sonnet-old', created_at: '2025-09-01T00:00:00Z' },
  { id: 'claude-sonnet-new', created_at: '2026-09-01T00:00:00Z' },
  { id: 'claude-opus-new', created_at: '2026-09-15T00:00:00Z' }
]

let db: Database.Database
let now: number

beforeEach(() => {
  db = createInMemoryDatabase()
  now = 1_000_000
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('ModelService', () => {
  it('Models API から一覧を取得してキャッシュし、既定モデルを設定する（MDL-02、MDL-05）', async () => {
    const fake = fakeClient({ models: MODELS })
    const service = new ModelService(
      db,
      () => fake.client,
      () => now
    )

    const list = await service.list()

    expect(list.stale).toBe(false)
    expect(list.models.map((m) => m.id)).toEqual(MODELS.map((m) => m.id))
    expect(list.models[0]).toMatchObject({ max_input_tokens: 1000000, max_tokens: 128000 })
    expect(service.getDefaultModel()).toBe('claude-sonnet-new')
  })

  it('キャッシュが新しい間は API を呼ばない。refresh で取得し直す', async () => {
    const fake = fakeClient({ models: MODELS })
    const service = new ModelService(
      db,
      () => fake.client,
      () => now
    )

    await service.list()
    now += MODELS_CACHE_TTL_MS - 1
    await service.list()
    expect(fake.calls()).toBe(1)

    await service.list(true)
    expect(fake.calls()).toBe(2)

    now += MODELS_CACHE_TTL_MS
    await service.list()
    expect(fake.calls()).toBe(3)
  })

  it('取得に失敗したら前回のキャッシュを stale として返す（MDL-02）', async () => {
    let client = fakeClient({ models: MODELS }).client
    const service = new ModelService(
      db,
      () => client,
      () => now
    )
    await service.list()

    client = fakeClient({ error: apiError(529, 'overloaded_error') }).client
    const list = await service.list(true)

    expect(list.stale).toBe(true)
    expect(list.models).toHaveLength(MODELS.length)
  })

  it('キャッシュも無く取得に失敗したら API エラーを投げる', async () => {
    const fake = fakeClient({ error: apiError(401, 'authentication_error') })
    const service = new ModelService(
      db,
      () => fake.client,
      () => now
    )

    await expect(service.list()).rejects.toMatchObject({ kind: 'auth' })
    await expect(service.list()).rejects.toBeInstanceOf(ApiRequestError)
  })

  it('API キーが未設定ならキャッシュを stale として返す', async () => {
    const service = new ModelService(
      db,
      () => null,
      () => now
    )
    expect(await service.list()).toEqual({ models: [], fetched_at: null, stale: true })
  })

  it('既定モデルは一覧にあるものだけ設定でき、利用者の選択は維持される', async () => {
    const service = new ModelService(
      db,
      () => fakeClient({ models: MODELS }).client,
      () => now
    )
    await service.list()

    expect(() => service.setDefaultModel('claude-unknown')).toThrow(ValidationError)
    service.setDefaultModel('claude-opus-new')
    await service.list(true)
    expect(service.getDefaultModel()).toBe('claude-opus-new')
  })

  it('既定モデルが一覧から消えたら選び直す', async () => {
    let models = MODELS
    const service = new ModelService(
      db,
      () => fakeClient({ models }).client,
      () => now
    )
    await service.list()
    service.setDefaultModel('claude-opus-new')

    models = MODELS.filter((m) => m.id !== 'claude-opus-new')
    await service.list(true)
    expect(service.getDefaultModel()).toBe('claude-sonnet-new')
  })
})

describe('pickDefaultModel / resolveModel', () => {
  const info = (id: string, created_at: string): ModelInfo => ({
    id,
    display_name: id,
    created_at,
    max_input_tokens: null,
    max_tokens: null,
    supports_adaptive_thinking: false,
    effort_levels: []
  })

  it('中位（Sonnet）が無ければ最新を選ぶ。空なら null', () => {
    expect(pickDefaultModel([info('a-opus', '2026-01-01'), info('b-haiku', '2026-02-01')])).toBe(
      'b-haiku'
    )
    expect(pickDefaultModel([])).toBeNull()
  })

  it('スレッド → プロジェクト → 全体の順に解決する（MDL-03）', () => {
    expect(resolveModel('d', 'p', 't')).toBe('t')
    expect(resolveModel('d', 'p', null)).toBe('p')
    expect(resolveModel('d', null, null)).toBe('d')
    expect(resolveModel(null, null, null)).toBeNull()
  })
})
