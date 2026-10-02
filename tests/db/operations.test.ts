/**
 * データベース操作のテスト
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createInMemoryDatabase } from '../../src/main/db/init'
import {
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listProjects,
  createThread,
  getThread,
  updateThread,
  deleteThread,
  listThreadsByProject,
  markThreadOpened,
  getLastOpenedThread,
  createMessage,
  getMessage,
  listMessagesByThread,
  getSetting,
  setSetting,
  deleteSetting,
  ValidationError
} from '../../src/main/db/operations'

let db: Database.Database

// 更新日時の比較が同一ミリ秒で不安定にならないよう、時計を固定して明示的に進める
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  db = createInMemoryDatabase()
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
})

describe('Project操作', () => {
  it('プロジェクトを作成できる', () => {
    const project = createProject(db, {
      type: 'chat',
      name: 'テストプロジェクト'
    })

    expect(project.id).toBeTruthy()
    expect(project.type).toBe('chat')
    expect(project.name).toBe('テストプロジェクト')
    expect(project.pinned).toBe(false)
    expect(project.archived).toBe(false)
  })

  it('プロジェクトを取得できる', () => {
    const created = createProject(db, {
      type: 'cowork',
      name: 'Coworkプロジェクト',
      work_folder: 'C:\\test\\folder'
    })

    const fetched = getProject(db, created.id)

    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(created.id)
    expect(fetched!.type).toBe('cowork')
    expect(fetched!.work_folder).toBe('C:\\test\\folder')
  })

  it('存在しないプロジェクトはnullを返す', () => {
    const result = getProject(db, 'non-existent-id')
    expect(result).toBeNull()
  })

  it('プロジェクトを更新できる', () => {
    const project = createProject(db, {
      type: 'chat',
      name: '元の名前'
    })

    vi.advanceTimersByTime(1000)
    const updated = updateProject(db, project.id, {
      name: '新しい名前',
      pinned: true
    })

    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('新しい名前')
    expect(updated!.pinned).toBe(true)
    expect(updated!.updated_at).toBeGreaterThan(project.updated_at)
  })

  it('プロジェクトを削除できる', () => {
    const project = createProject(db, {
      type: 'chat',
      name: '削除テスト'
    })

    const deleted = deleteProject(db, project.id)
    expect(deleted).toBe(true)

    const fetched = getProject(db, project.id)
    expect(fetched).toBeNull()
  })

  it('プロジェクト一覧を取得できる（ピン留め優先、更新日時降順）', () => {
    createProject(db, { type: 'chat', name: 'プロジェクト1' })
    const p2 = createProject(db, { type: 'chat', name: 'プロジェクト2' })
    const p3 = createProject(db, { type: 'chat', name: 'プロジェクト3' })

    // p2をピン留め
    updateProject(db, p2.id, { pinned: true })

    // p3をアーカイブ
    updateProject(db, p3.id, { archived: true })

    const projects = listProjects(db)

    // アーカイブは除外され、ピン留めが最初
    expect(projects).toHaveLength(2)
    expect(projects[0].id).toBe(p2.id)
    expect(projects[0].pinned).toBe(true)
  })

  it('Coworkは作業フォルダなしで作成できない（PRJ-03）', () => {
    expect(() => createProject(db, { type: 'cowork', name: 'Cowork' })).toThrow(ValidationError)
    expect(() => createProject(db, { type: 'cowork', name: 'Cowork', work_folder: '' })).toThrow(
      '作業フォルダを指定してください'
    )
  })

  it('通常チャットに作業フォルダは設定できない', () => {
    expect(() =>
      createProject(db, { type: 'chat', name: 'チャット', work_folder: 'C:\\test' })
    ).toThrow(ValidationError)
  })

  it('Coworkの作業フォルダを空に更新できない（PRJ-03）', () => {
    const project = createProject(db, {
      type: 'cowork',
      name: 'Cowork',
      work_folder: 'C:\\test\\folder'
    })

    expect(() => updateProject(db, project.id, { work_folder: '' })).toThrow(ValidationError)
    expect(getProject(db, project.id)!.work_folder).toBe('C:\\test\\folder')
  })
})

describe('プロジェクトの入力検証', () => {
  it('空・空白のみの名前は保存できない（PRJ-02）', () => {
    expect(() => createProject(db, { type: 'chat', name: '' })).toThrow(
      'プロジェクト名を入力してください'
    )
    expect(() => createProject(db, { type: 'chat', name: '　 ' })).toThrow(ValidationError)

    const project = createProject(db, { type: 'chat', name: '名前' })
    expect(() => updateProject(db, project.id, { name: ' ' })).toThrow(ValidationError)
    expect(getProject(db, project.id)!.name).toBe('名前')
  })

  it('名前は100文字まで（サロゲートペアも1文字として数える）', () => {
    expect(createProject(db, { type: 'chat', name: '𠮷'.repeat(100) }).name).toBe('𠮷'.repeat(100))
    expect(() => createProject(db, { type: 'chat', name: 'a'.repeat(101) })).toThrow('100 文字以内')
  })

  it('カスタム指示は20,000文字まで', () => {
    createProject(db, { type: 'chat', name: 'ok', custom_instructions: 'a'.repeat(20000) })
    expect(() =>
      createProject(db, { type: 'chat', name: 'ng', custom_instructions: 'a'.repeat(20001) })
    ).toThrow('20,000 文字以内')
  })
})

describe('Thread操作', () => {
  let projectId: string

  beforeEach(() => {
    const project = createProject(db, {
      type: 'chat',
      name: 'テストプロジェクト'
    })
    projectId = project.id
  })

  it('スレッドを作成できる', () => {
    const thread = createThread(db, {
      project_id: projectId,
      title: 'テストスレッド'
    })

    expect(thread.id).toBeTruthy()
    expect(thread.project_id).toBe(projectId)
    expect(thread.title).toBe('テストスレッド')
    expect(thread.extended_thinking).toBe(false)
  })

  it('スレッドを取得できる', () => {
    const created = createThread(db, {
      project_id: projectId,
      title: 'スレッド1',
      extended_thinking: true
    })

    const fetched = getThread(db, created.id)

    expect(fetched).not.toBeNull()
    expect(fetched!.title).toBe('スレッド1')
    expect(fetched!.extended_thinking).toBe(true)
  })

  it('スレッドを更新できる', () => {
    const thread = createThread(db, {
      project_id: projectId,
      title: '元のタイトル'
    })

    const updated = updateThread(db, thread.id, {
      title: '新しいタイトル',
      model: 'claude-sonnet-4-20250514'
    })

    expect(updated).not.toBeNull()
    expect(updated!.title).toBe('新しいタイトル')
    expect(updated!.model).toBe('claude-sonnet-4-20250514')
  })

  it('スレッドを削除できる', () => {
    const thread = createThread(db, {
      project_id: projectId
    })

    const deleted = deleteThread(db, thread.id)
    expect(deleted).toBe(true)

    const fetched = getThread(db, thread.id)
    expect(fetched).toBeNull()
  })

  it('プロジェクトごとのスレッド一覧を取得できる', () => {
    const t1 = createThread(db, { project_id: projectId, title: 'スレッド1' })
    const t2 = createThread(db, { project_id: projectId, title: 'スレッド2' })

    const threads = listThreadsByProject(db, projectId)

    expect(threads).toHaveLength(2)
    // updated_at降順なので、後から作成されたスレッドが先
    // ただし同じミリ秒の場合は順序が不定なので、IDで判定
    const threadIds = threads.map((t) => t.id)
    expect(threadIds).toContain(t1.id)
    expect(threadIds).toContain(t2.id)
  })

  it('最後に開いたスレッドを取得できる（THR-05）', () => {
    const t1 = createThread(db, { project_id: projectId })
    const t2 = createThread(db, { project_id: projectId })

    expect(getLastOpenedThread(db, projectId)).toBeNull()

    markThreadOpened(db, t2.id)
    vi.advanceTimersByTime(1000)
    markThreadOpened(db, t1.id)

    expect(getLastOpenedThread(db, projectId)!.id).toBe(t1.id)
    // 開いただけでは更新日時は変わらない
    expect(getThread(db, t1.id)!.updated_at).toBe(t1.updated_at)
  })

  it('プロジェクト削除時にスレッドもカスケード削除される', () => {
    const thread = createThread(db, { project_id: projectId })

    deleteProject(db, projectId)

    const fetched = getThread(db, thread.id)
    expect(fetched).toBeNull()
  })
})

describe('Message操作', () => {
  let threadId: string

  beforeEach(() => {
    const project = createProject(db, {
      type: 'chat',
      name: 'テストプロジェクト'
    })
    const thread = createThread(db, {
      project_id: project.id
    })
    threadId = thread.id
  })

  it('メッセージを作成できる', () => {
    const message = createMessage(db, {
      thread_id: threadId,
      role: 'user',
      content: 'こんにちは'
    })

    expect(message.id).toBeTruthy()
    expect(message.thread_id).toBe(threadId)
    expect(message.role).toBe('user')
    expect(message.content).toBe('こんにちは')
  })

  it('メッセージを取得できる', () => {
    const created = createMessage(db, {
      thread_id: threadId,
      role: 'assistant',
      content: 'こんにちは！',
      tokens_used: 100,
      estimated_cost: 0.0015
    })

    const fetched = getMessage(db, created.id)

    expect(fetched).not.toBeNull()
    expect(fetched!.content).toBe('こんにちは！')
    expect(fetched!.tokens_used).toBe(100)
    expect(fetched!.estimated_cost).toBe(0.0015)
  })

  it('スレッドごとのメッセージ一覧を取得できる（時系列順）', () => {
    createMessage(db, {
      thread_id: threadId,
      role: 'user',
      content: '最初のメッセージ'
    })

    createMessage(db, {
      thread_id: threadId,
      role: 'assistant',
      content: '2番目のメッセージ'
    })

    createMessage(db, {
      thread_id: threadId,
      role: 'user',
      content: '3番目のメッセージ'
    })

    const messages = listMessagesByThread(db, threadId)

    expect(messages).toHaveLength(3)
    expect(messages[0].content).toBe('最初のメッセージ')
    expect(messages[1].content).toBe('2番目のメッセージ')
    expect(messages[2].content).toBe('3番目のメッセージ')
  })

  it('親メッセージを指定して分岐を作成できる', () => {
    const parent = createMessage(db, {
      thread_id: threadId,
      role: 'user',
      content: '親メッセージ'
    })

    const child = createMessage(db, {
      thread_id: threadId,
      parent_id: parent.id,
      role: 'assistant',
      content: '子メッセージ'
    })

    expect(child.parent_id).toBe(parent.id)
  })

  it('メッセージ追加でスレッドとプロジェクトの更新日時が更新される', () => {
    const before = getThread(db, threadId)!

    vi.advanceTimersByTime(1000)
    const message = createMessage(db, { thread_id: threadId, role: 'user', content: 'こんにちは' })

    expect(getThread(db, threadId)!.updated_at).toBe(message.created_at)
    expect(getProject(db, before.project_id)!.updated_at).toBe(message.created_at)
    expect(message.created_at).toBeGreaterThan(before.updated_at)
  })

  it('同一ミリ秒のメッセージも作成順に並ぶ', () => {
    for (let i = 0; i < 20; i++) {
      createMessage(db, { thread_id: threadId, role: 'user', content: `m${i}` })
    }

    const contents = listMessagesByThread(db, threadId).map((m) => m.content)
    expect(contents).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`))
  })
})

describe('Settings操作', () => {
  it('設定を保存・取得できる', () => {
    setSetting(db, 'default_model', 'claude-sonnet-4-20250514')

    const value = getSetting(db, 'default_model')
    expect(value).toBe('claude-sonnet-4-20250514')
  })

  it('存在しない設定はnullを返す', () => {
    const value = getSetting(db, 'non_existent_key')
    expect(value).toBeNull()
  })

  it('設定を上書きできる', () => {
    setSetting(db, 'theme', 'dark')
    setSetting(db, 'theme', 'light')

    const value = getSetting(db, 'theme')
    expect(value).toBe('light')
  })

  it('設定を削除できる', () => {
    setSetting(db, 'temp_setting', 'value')

    const deleted = deleteSetting(db, 'temp_setting')
    expect(deleted).toBe(true)

    const value = getSetting(db, 'temp_setting')
    expect(value).toBeNull()
  })
})

describe('使用量記録・操作ログ', () => {
  it('プロジェクト削除後も使用量記録が残る（USG-02〜04）', () => {
    const project = createProject(db, { type: 'chat', name: '削除されるプロジェクト' })
    const thread = createThread(db, { project_id: project.id })

    db.prepare(
      `INSERT INTO usage_records (
        id, project_id, project_name, thread_id, model, input_tokens, output_tokens,
        estimated_cost, created_at
      ) VALUES ('u1', ?, ?, ?, 'model-x', 100, 50, 0.01, ?)`
    ).run(project.id, project.name, thread.id, Date.now())

    deleteProject(db, project.id)

    const row = db.prepare('SELECT * FROM usage_records WHERE id = ?').get('u1') as {
      project_id: string | null
      project_name: string
      thread_id: string | null
      estimated_cost: number
    }
    expect(row.project_id).toBeNull()
    expect(row.thread_id).toBeNull()
    expect(row.project_name).toBe('削除されるプロジェクト')
    expect(row.estimated_cost).toBe(0.01)
  })

  it('自動許可された操作を操作ログに記録できる（LOG-01）', () => {
    const project = createProject(db, {
      type: 'cowork',
      name: 'Cowork',
      work_folder: 'C:\\test'
    })
    const thread = createThread(db, { project_id: project.id })
    const insert = db.prepare(
      `INSERT INTO tool_events (id, thread_id, tool_name, permission_method, created_at)
       VALUES (?, ?, 'Read', ?, ?)`
    )

    for (const method of [
      'auto',
      'allowed_once',
      'allowed_always_thread',
      'allowed_always_project',
      'denied'
    ]) {
      insert.run(method, thread.id, method, Date.now())
    }
    expect(() => insert.run('x', thread.id, 'allowed_always', Date.now())).toThrow()
    expect(() => insert.run('y', thread.id, null, Date.now())).toThrow()
  })
})
