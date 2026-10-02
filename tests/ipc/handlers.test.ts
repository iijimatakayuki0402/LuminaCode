/**
 * IPC ハンドラーのテスト（登録処理を通した結果の値で確認する）
 */

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcChannel, IpcResult } from '../../src/shared/ipc'
import type { Project, Thread } from '../../src/shared/types'
import { createInMemoryDatabase } from '../../src/main/db/init'
import { createHandlers, type IpcHandlers } from '../../src/main/ipc/handlers'
import { invokeHandler } from '../../src/main/ipc/register'

let db: Database.Database
let handlers: IpcHandlers

const call = <T = unknown>(channel: IpcChannel, ...args: unknown[]): Promise<IpcResult<T>> =>
  invokeHandler(handlers, channel, true, args) as Promise<IpcResult<T>>

async function value<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const result = await call<T>(channel, ...args)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

beforeEach(() => {
  db = createInMemoryDatabase()
  handlers = createHandlers({
    db,
    appInfo: { version: '0.1.0', electron: 'e', chrome: 'c', dataPath: 'C:\\data' }
  })
})

afterEach(() => {
  db.close()
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
