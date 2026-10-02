/**
 * IPC ハンドラーのテスト（登録処理を通した結果の値で確認する）
 */

import type Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcChannel, IpcResult } from '../../src/shared/ipc'
import type { ApiKeyStatus, Appearance, ModelList, Project, Thread } from '../../src/shared/types'
import { createInMemoryDatabase } from '../../src/main/db/init'
import { createHandlers, type IpcHandlers } from '../../src/main/ipc/handlers'
import { invokeHandler } from '../../src/main/ipc/register'
import { AttachmentStore } from '../../src/main/chat/attachments'
import { ChatService } from '../../src/main/chat/chatService'
import { CoworkService } from '../../src/main/cowork/coworkService'
import { ModelService } from '../../src/main/models/modelService'
import { UsageService } from '../../src/main/usage/usageService'
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
let selectedFolder: string | null = null
let saved: { name: string; content: string } | null = null

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

  const attachments = new AttachmentStore(join(dir, 'attachments'))
  const chatService = new ChatService({
    db,
    attachments,
    modelService,
    getApiKey: () => apiKeyStore.get(),
    createClient,
    emit: () => undefined
  })

  const coworkService = new CoworkService({
    db,
    snapshotsDir: join(dir, 'snapshots'),
    modelService,
    getApiKey: () => apiKeyStore.get(),
    configDir: join(dir, 'agent'),
    emit: () => undefined
  })

  handlers = createHandlers({
    db,
    apiKeyStore,
    modelService,
    createClient,
    chatService,
    coworkService,
    usage: new UsageService(db, join(dir, 'pricing.json')),
    saveFile: async (name, content) => {
      saved = { name, content }
      return join(dir, name)
    },
    attachments,
    selectFiles: async () => [],
    workFolderPolicy: {
      userDataPath: join(dir, 'userData'),
      homeDir: join(dir, 'home'),
      systemRoot: join(dir, 'Windows')
    },
    selectFolder: async (defaultPath) => selectedFolder ?? defaultPath ?? null,
    appInfo: {
      version: '0.1.0',
      electron: 'e',
      chrome: 'c',
      dataPath: 'C:\\data',
      pricingPath: 'p',
      logPath: 'l'
    }
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

describe('Stage 4: 作業フォルダ・一覧・表示設定・フォルダ選択', () => {
  it('Cowork の作業フォルダを検証して実体パスで保存する（PRJ-05）', async () => {
    const work = join(dir, 'work')
    mkdirSync(work)

    const project = await value<Project>('projects:create', {
      type: 'cowork',
      name: 'C',
      work_folder: work
    })
    expect(project.work_folder).toBe(realpathSync.native(work))
  })

  it('指定できないフォルダ・存在しないフォルダは validation（作成・更新とも）', async () => {
    const userData = join(dir, 'userData')
    mkdirSync(userData)
    expect(
      await call('projects:create', { type: 'cowork', name: 'C', work_folder: userData })
    ).toMatchObject({
      error: { code: 'validation', message: expect.stringContaining('データ保存先') }
    })
    expect(
      await call('projects:create', { type: 'cowork', name: 'C', work_folder: join(dir, 'none') })
    ).toMatchObject({
      error: { code: 'validation', message: expect.stringContaining('見つかりません') }
    })

    const work = join(dir, 'work')
    mkdirSync(work)
    const project = await value<Project>('projects:create', {
      type: 'cowork',
      name: 'C',
      work_folder: work
    })
    expect(await call('projects:update', project.id, { work_folder: userData })).toMatchObject({
      error: { code: 'validation' }
    })
  })

  it('アーカイブ済みは既定で一覧に含めず、指定すれば含める（DSH-07）', async () => {
    const a = await value<Project>('projects:create', { type: 'chat', name: 'A' })
    await value<Project>('projects:create', { type: 'chat', name: 'B' })
    await value('projects:update', a.id, { archived: true })

    expect(await value<Project[]>('projects:list')).toHaveLength(1)
    expect(await value<Project[]>('projects:list', { includeArchived: true })).toHaveLength(2)
    expect(await call('projects:list', { includeArchived: 'yes' })).toMatchObject({
      error: { code: 'invalid_argument' }
    })
  })

  it('表示設定の既定値は標準・水色で、変更が保持される（CMN-01、CMN-06）', async () => {
    expect(await value<Appearance>('settings:getAppearance')).toEqual({
      mode: 'system',
      accent: 'cyan'
    })
    expect(await value<Appearance>('settings:setAppearance', { accent: 'purple' })).toEqual({
      mode: 'system',
      accent: 'purple'
    })
    await value('settings:setAppearance', { mode: 'dark' })
    expect(await value<Appearance>('settings:getAppearance')).toEqual({
      mode: 'dark',
      accent: 'purple'
    })
    expect(await call('settings:setAppearance', { accent: 'green' })).toMatchObject({
      error: { code: 'invalid_argument' }
    })
  })

  it('フォルダ選択の結果を返す（キャンセル時は null）', async () => {
    selectedFolder = 'picked-folder'
    expect(await value('dialog:selectFolder')).toBe('picked-folder')
    selectedFolder = null
    expect(await value('dialog:selectFolder')).toBeNull()
    expect(await call('dialog:selectFolder', 1)).toMatchObject({
      error: { code: 'invalid_argument' }
    })
  })
})

describe('Stage 5: チャット・添付ファイルの引数検証', () => {
  it('送信の引数を検証し、キー未設定なら validation', async () => {
    const project = await value<Project>('projects:create', { type: 'chat', name: 'P' })
    const thread = await value<Thread>('threads:create', { project_id: project.id })

    expect(
      await call('chat:send', { threadId: thread.id, content: 1, attachmentIds: [] })
    ).toMatchObject({
      error: { code: 'invalid_argument' }
    })
    expect(
      await call('chat:send', { threadId: thread.id, content: 'x', attachmentIds: [], extra: 1 })
    ).toMatchObject({ error: { code: 'invalid_argument' } })
    expect(
      await call('chat:send', { threadId: thread.id, content: 'x', attachmentIds: [] })
    ).toMatchObject({
      error: { code: 'validation', message: expect.stringContaining('API キー') }
    })
  })

  it('貼り付けた画像を仮置きでき、形式エラーは理由を返す', async () => {
    const ok = await value<{ staged: { filename: string }[]; errors: string[] }>(
      'attachments:stageData',
      'paste.png',
      new Uint8Array([1, 2, 3])
    )
    expect(ok.staged.map((s) => s.filename)).toEqual(['paste.png'])

    const ng = await value<{ staged: unknown[]; errors: string[] }>(
      'attachments:stageData',
      'a.docx',
      new Uint8Array([1])
    )
    expect(ng.staged).toEqual([])
    expect(ng.errors[0]).toContain('Office')
    expect(await call('attachments:stageData', 'a.png', 'not-bytes')).toMatchObject({
      error: { code: 'invalid_argument' }
    })
  })

  it('送信キーの設定（CHT-09）', async () => {
    expect(await value('settings:getChatPrefs')).toEqual({ sendKey: 'enter' })
    expect(await value('settings:setChatPrefs', { sendKey: 'ctrl_enter' })).toEqual({
      sendKey: 'ctrl_enter'
    })
    expect(await call('settings:setChatPrefs', { sendKey: 'shift' })).toMatchObject({
      error: { code: 'invalid_argument' }
    })
  })
})

describe('Stage 6: Cowork・操作ログ', () => {
  it('送信は Cowork に振り分ける（添付は受け付けない）', async () => {
    mkdirSync(join(dir, 'work'))
    const project = await value<Project>('projects:create', {
      type: 'cowork',
      name: 'C',
      work_folder: join(dir, 'work')
    })
    const thread = await value<Thread>('threads:create', { project_id: project.id })
    await value('apiKey:save', VALID_KEY)
    expect(
      await call('chat:send', { threadId: thread.id, content: 'x', attachmentIds: ['a'] })
    ).toMatchObject({ error: { code: 'validation', message: expect.stringContaining('Cowork') } })
    expect(await value('cowork:trashList', project.id)).toEqual([])
    expect(await value('cowork:getAlways', project.id, thread.id)).toEqual({
      thread: [],
      project: []
    })
  })

  it('通常チャットのプロジェクトでは退避先を扱えない', async () => {
    const project = await value<Project>('projects:create', { type: 'chat', name: 'P' })
    expect(await call('cowork:trashList', project.id)).toMatchObject({
      error: { code: 'validation' }
    })
  })

  it('操作ログを検索・書き出し・削除できる（LOG-02、LOG-03）', async () => {
    mkdirSync(join(dir, 'work2'))
    const project = await value<Project>('projects:create', {
      type: 'cowork',
      name: 'ログ',
      work_folder: join(dir, 'work2')
    })
    const thread = await value<Thread>('threads:create', { project_id: project.id })
    const now = Date.now()
    for (const [i, category, target] of [
      [0, 'read', 'a.txt'],
      [1, 'write', '=cmd.txt'],
      [2, 'command', null]
    ] as const) {
      db.prepare(
        `INSERT INTO tool_events (id, thread_id, tool_name, category, target, command, permission_method, created_at)
         VALUES (?, ?, 'T', ?, ?, ?, 'auto', ?)`
      ).run(
        `e${i}`,
        thread.id,
        category,
        target,
        category === 'command' ? 'npm test' : null,
        now - i * 1000
      )
    }

    expect(await value<unknown[]>('logs:search', {})).toHaveLength(3)
    expect(await value('logs:search', { category: 'write' })).toMatchObject([
      { id: 'e1', project_name: 'ログ' }
    ])
    expect(await value('logs:search', { query: 'npm' })).toMatchObject([{ id: 'e2' }])

    expect(await value('logs:export', {}, 'csv')).toContain('.csv')
    expect(saved!.content.startsWith('\ufeffcreated_at,project_name')).toBe(true)
    // 数式として解釈されないようにする
    expect(saved!.content).toContain("'=cmd.txt")

    expect(await value('logs:deleteBefore', now - 500)).toBe(2)
    expect(await value<unknown[]>('logs:search', {})).toHaveLength(1)
    expect(await call('logs:search', { category: 'nope' })).toMatchObject({
      error: { code: 'invalid_argument' }
    })
  })
})

describe('Stage 7: 使用量', () => {
  it('上限の設定・状態・プロジェクト別上限', async () => {
    const project = await value<Project>('projects:create', { type: 'chat', name: 'P' })
    expect(await value('usage:getLimits')).toEqual({ monthlyLimit: null, action: 'stop' })
    expect(await value('usage:setLimits', { monthlyLimit: 10, action: 'warn' })).toEqual({
      monthlyLimit: 10,
      action: 'warn'
    })
    await value('usage:setProjectLimit', project.id, 3)
    expect(await value('usage:status', project.id)).toMatchObject({
      monthlyLimit: 10,
      projectLimit: 3,
      level: 'ok'
    })
    expect(await call('usage:setLimits', { monthlyLimit: 'x' })).toMatchObject({
      error: { code: 'invalid_argument' }
    })
    expect(await call('usage:summary', '2026-13')).toMatchObject({
      error: { code: 'invalid_argument' }
    })
    expect(await value('usage:summary', '2026-10')).toMatchObject({
      month: '2026-10',
      projects: [],
      projectLimits: { [project.id]: 3 }
    })
  })
})
