/**
 * IPC ハンドラーのテスト（登録処理を通した結果の値で確認する）
 */

import type Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcChannel, IpcResult } from '../../src/shared/ipc'
import type { ApiKeyStatus, ModelList, Project, Thread } from '../../src/shared/types'
import { createInMemoryDatabase } from '../../src/main/db/init'
import { createHandlers, type IpcHandlers } from '../../src/main/ipc/handlers'
import { invokeHandler } from '../../src/main/ipc/register'
import { ModelService } from '../../src/main/models/modelService'
import { ApiKeyStore, type SecretCipher } from '../../src/main/secrets/apiKeyStore'
import { apiError, fakeClient } from '../helpers/fakeAnthropic'

const VALID_KEY = 'sk-ant-valid-key-1234'
const MODELS = [
  { id: 'claude-sonnet-a', created_at: '2026-01-01T00:00:00Z' },
  { id: 'claude-opus-b', created_at: '2026-02-01T00:00:00Z' }
]

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s).reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString()
}

let db: Database.Database
let handlers: IpcHandlers
let dir: string
let keyFile: string
let usedKeys: string[]

const call = <T = unknown>(channel: IpcChannel, ...args: unknown[]): Promise<IpcResult<T>> =>
  invokeHandler(handlers, channel, true, args) as Promise<IpcResult<T>>

async function value<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const result = await call<T>(channel, ...args)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

beforeEach(() => {
  db = createInMemoryDatabase()
  dir = mkdtempSync(join(tmpdir(), 'lumina-ipc-'))
  keyFile = join(dir, 'api-key.bin')
  usedKeys = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  // VALID_KEY のときだけ成功し、それ以外は 401 を返すクライアント
  const createClient = (apiKey: string): Anthropic => {
    usedKeys.push(apiKey)
    return apiKey === VALID_KEY
      ? fakeClient({ models: MODELS }).client
      : fakeClient({ error: apiError(401, 'authentication_error') }).client
  }
  const apiKeyStore = new ApiKeyStore(keyFile, cipher)
  const modelService = new ModelService(db, () => {
    const key = apiKeyStore.get()
    return key === null ? null : createClient(key)
  })

  handlers = createHandlers({
    db,
    apiKeyStore,
    modelService,
    createClient,
    appInfo: { version: '0.1.0', electron: 'e', chrome: 'c', dataPath: 'C:\\data' }
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('呼び出しの共通処理', () => {
  it('信頼できない送信元は拒否する', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await invokeHandler(handlers, 'projects:list', false, [])
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) })
  })

  it('入力検証エラーは validation として文言をそのまま返す', async () => {
    const result = await call('projects:create', { type: 'chat', name: ' ' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'validation', message: 'プロジェクト名を入力してください。' }
    })
  })

  it('想定外のエラーは詳細を返さない', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.close()

    const result = await call('projects:list')

    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: '予期しないエラーが発生しました。' }
    })
    expect(spy).toHaveBeenCalled()
    db = createInMemoryDatabase()
  })
})

describe('app', () => {
  it('アプリ情報を返す', async () => {
    expect(await value('app:getInfo')).toMatchObject({ version: '0.1.0', dataPath: 'C:\\data' })
  })
})

describe('projects', () => {
  it('作成・取得・更新・一覧・削除ができる', async () => {
    const created = await value<Project>('projects:create', { type: 'chat', name: 'A' })
    expect(await value('projects:get', created.id)).toEqual(created)

    const updated = await value<Project>('projects:update', created.id, { pinned: true })
    expect(updated.pinned).toBe(true)

    expect(await value<Project[]>('projects:list')).toHaveLength(1)

    await value('projects:delete', created.id)
    expect(await call('projects:get', created.id)).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
  })

  it('存在しないプロジェクトの更新・削除は not_found', async () => {
    expect(await call('projects:update', 'missing', { name: 'x' })).toMatchObject({
      error: { code: 'not_found' }
    })
    expect(await call('projects:delete', 'missing')).toMatchObject({
      error: { code: 'not_found' }
    })
  })

  it('種別は更新できない（PRJ-04）', async () => {
    const created = await value<Project>('projects:create', { type: 'chat', name: 'A' })
    const result = await call('projects:update', created.id, { type: 'cowork' })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect((await value<Project>('projects:get', created.id)).type).toBe('chat')
  })

  it('不正な形式の引数は invalid_argument', async () => {
    const cases: unknown[][] = [
      [undefined],
      ['not-object'],
      [{ type: 'other', name: 'A' }],
      [{ type: 'chat', name: 1 }],
      [{ type: 'chat', name: 'A', pinned: true }],
      [{ type: 'chat', name: 'A', permission_mode: 'bypass' }]
    ]
    for (const args of cases) {
      expect(await call('projects:create', ...args)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(await call('projects:get', 123)).toMatchObject({ error: { code: 'invalid_argument' } })
    expect(await call('projects:get', '')).toMatchObject({ error: { code: 'invalid_argument' } })
  })
})

describe('threads / messages', () => {
  let project: Project

  beforeEach(async () => {
    project = await value<Project>('projects:create', { type: 'chat', name: 'P' })
  })

  it('作成・更新・一覧・削除ができる', async () => {
    const thread = await value<Thread>('threads:create', { project_id: project.id, title: 'T' })
    const updated = await value<Thread>('threads:update', thread.id, { title: 'T2' })
    expect(updated.title).toBe('T2')

    expect(await value<Thread[]>('threads:listByProject', project.id)).toHaveLength(1)
    expect(await value('messages:listByThread', thread.id)).toEqual([])

    await value('threads:delete', thread.id)
    expect(await value<Thread[]>('threads:listByProject', project.id)).toHaveLength(0)
  })

  it('最後に開いたスレッドを記録・取得できる', async () => {
    expect(await value('threads:getLastOpened', project.id)).toBeNull()

    const thread = await value<Thread>('threads:create', { project_id: project.id })
    await value('threads:markOpened', thread.id)

    expect((await value<Thread>('threads:getLastOpened', project.id)).id).toBe(thread.id)
  })

  it('存在しないプロジェクトにはスレッドを作れない', async () => {
    expect(await call('threads:create', { project_id: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
  })
})

describe('apiKey / models（要件 KEY-01〜04、MDL-01〜05）', () => {
  it('無効なキーは疎通テストで拒否され、保存されない（受け入れ基準 2）', async () => {
    const result = await call('apiKey:save', 'sk-ant-invalid-0000')

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'api',
        apiKind: 'auth',
        message: 'API キーが無効です。設定画面で API キーを確認してください。'
      }
    })
    expect(existsSync(keyFile)).toBe(false)
    expect((await value<ApiKeyStatus>('apiKey:getStatus')).configured).toBe(false)
  })

  it('有効なキーは保存され、モデル一覧と既定モデルが設定される', async () => {
    const status = await value<ApiKeyStatus>('apiKey:save', `  ${VALID_KEY}  `)

    expect(status).toEqual({ configured: true, masked: '••••••••1234', encryptionAvailable: true })
    expect(usedKeys[0]).toBe(VALID_KEY)
    expect(readFileSync(keyFile).toString()).not.toContain(VALID_KEY)
    expect(await value('models:getDefault')).toBe('claude-sonnet-a')

    const list = await value<ModelList>('models:list')
    expect(list.models.map((m) => m.id)).toEqual(['claude-sonnet-a', 'claude-opus-b'])
  })

  it('API キーが renderer への戻り値に含まれない', async () => {
    const results = [
      await call('apiKey:save', VALID_KEY),
      await call('apiKey:getStatus'),
      await call('apiKey:test'),
      await call('models:list', true)
    ]
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain('valid-key')
    }
  })

  it('保存済みキーの疎通テスト。未設定なら validation', async () => {
    expect(await call('apiKey:test')).toMatchObject({ error: { code: 'validation' } })
    await value('apiKey:save', VALID_KEY)
    expect(await call('apiKey:test')).toEqual({ ok: true, value: undefined })
  })

  it('キーを削除できる', async () => {
    await value('apiKey:save', VALID_KEY)
    const status = await value<ApiKeyStatus>('apiKey:delete')

    expect(status.configured).toBe(false)
    expect(existsSync(keyFile)).toBe(false)
  })

  it('既定モデルを変更できる。一覧に無いモデルは validation', async () => {
    await value('apiKey:save', VALID_KEY)

    await value('models:setDefault', 'claude-opus-b')
    expect(await value('models:getDefault')).toBe('claude-opus-b')
    expect(await call('models:setDefault', 'claude-unknown')).toMatchObject({
      error: { code: 'validation' }
    })
  })

  it('引数の形式を検証する', async () => {
    expect(await call('apiKey:save', 123)).toMatchObject({ error: { code: 'invalid_argument' } })
    expect(await call('apiKey:save', '')).toMatchObject({ error: { code: 'validation' } })
    expect(await call('models:list', 'yes')).toMatchObject({ error: { code: 'invalid_argument' } })
  })
})
