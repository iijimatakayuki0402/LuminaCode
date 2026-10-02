/**
 * データベース操作のテスト
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  createMessage,
  getMessage,
  listMessagesByThread,
  getSetting,
  setSetting,
  deleteSetting
} from '../../src/main/db/operations'

let db: Database.Database

beforeEach(() => {
  db = createInMemoryDatabase()
})

afterEach(() => {
  db.close()
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
