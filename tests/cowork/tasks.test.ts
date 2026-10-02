import { describe, expect, it } from 'vitest'
import { TaskTracker } from '../../src/main/cowork/tasks'

describe('作業の一覧（COW-13）', () => {
  it('作成・更新・削除を反映し、ID の順に並べる', () => {
    const t = new TaskTracker()
    t.apply(
      'TaskCreate',
      { subject: 'B', activeForm: 'B 中' },
      { task: { id: '10', subject: 'B' } }
    )
    expect(t.apply('TaskCreate', { subject: 'A' }, '{"task":{"id":"2","subject":"A"}}')).toEqual([
      { content: 'A', status: 'pending', activeForm: 'A' },
      { content: 'B', status: 'pending', activeForm: 'B 中' }
    ])
    expect(
      t.apply('TaskUpdate', { taskId: '10', status: 'in_progress' }, { success: true })
    ).toEqual([
      { content: 'A', status: 'pending', activeForm: 'A' },
      { content: 'B', status: 'in_progress', activeForm: 'B 中' }
    ])
    expect(t.apply('TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true })).toEqual([
      { content: 'B', status: 'in_progress', activeForm: 'B 中' }
    ])
  })

  it('失敗した更新・知らない作業・関係のないツールは無視する', () => {
    const t = new TaskTracker()
    t.apply('TaskCreate', { subject: 'A' }, { task: { id: '1', subject: 'A' } })
    expect(
      t.apply('TaskUpdate', { taskId: '1', status: 'completed' }, { success: false })
    ).toBeNull()
    expect(
      t.apply('TaskUpdate', { taskId: '9', status: 'completed' }, { success: true })
    ).toBeNull()
    expect(t.apply('Read', { file_path: 'a' }, 'x')).toBeNull()
    expect(t.list()).toEqual([{ content: 'A', status: 'pending', activeForm: 'A' }])
  })

  it('TaskList の結果で一覧を合わせる（再開したセッションで以前の作業がある場合）', () => {
    const t = new TaskTracker()
    expect(
      t.apply(
        'TaskList',
        {},
        {
          tasks: [
            { id: '1', subject: 'A', status: 'completed', blockedBy: [] },
            { id: '2', subject: 'B', status: 'bogus', blockedBy: [] }
          ]
        }
      )
    ).toEqual([{ content: 'A', status: 'completed', activeForm: 'A' }])
  })
})
