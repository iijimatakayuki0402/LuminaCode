import type Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../../src/shared/types'
import { cleanTitle, TitleGenerator } from '../../src/main/chat/titleGenerator'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { ModelService } from '../../src/main/models/modelService'

let db: Database.Database
let threadId: string
let events: ChatEvent[]
let calls: Record<string, unknown>[]

const generator = (reply: string): TitleGenerator =>
  new TitleGenerator({
    db,
    modelService: new ModelService(db, () => null),
    getApiKey: () => 'sk-test',
    createClient: () =>
      ({
        messages: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params)
            return {
              content: [{ type: 'text', text: reply }],
              usage: { input_tokens: 50, output_tokens: 8 }
            }
          }
        }
      }) as unknown as Anthropic,
    emit: (e) => events.push(e)
  })

beforeEach(() => {
  db = createInMemoryDatabase()
  events = []
  calls = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ops.setSetting(
    db,
    'models_cache',
    JSON.stringify({
      fetched_at: Date.now(),
      models: [
        {
          id: 'claude-sonnet-x',
          display_name: 'S',
          created_at: '2026-02-01',
          max_input_tokens: 1,
          max_tokens: 1,
          supports_adaptive_thinking: true,
          effort_levels: ['low']
        },
        {
          id: 'claude-haiku-old',
          display_name: 'H1',
          created_at: '2025-01-01',
          max_input_tokens: 1,
          max_tokens: 1,
          supports_adaptive_thinking: false,
          effort_levels: []
        },
        {
          id: 'claude-haiku-new',
          display_name: 'H2',
          created_at: '2025-10-01',
          max_input_tokens: 1,
          max_tokens: 1,
          supports_adaptive_thinking: false,
          effort_levels: []
        }
      ]
    })
  )
  const project = ops.createProject(db, { type: 'chat', name: 'P' })
  threadId = ops.createThread(db, { project_id: project.id, title: '旅行の計画を…' }).id
  ops.updateThread(db, threadId, { title_source: 'auto' })
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('TitleGenerator（THR-03）', () => {
  it('最新の Haiku でタイトルを作り、使用量を記録して通知する', async () => {
    await generator('「京都の紅葉旅行の計画」').generate(
      threadId,
      '京都に行きたい',
      '紅葉の時期は…',
      'claude-sonnet-x'
    )

    expect(calls[0]).toMatchObject({ model: 'claude-haiku-new', max_tokens: 1024 })
    expect(ops.getThread(db, threadId)).toMatchObject({
      title: '京都の紅葉旅行の計画',
      title_source: 'ai'
    })
    expect(events).toEqual([{ type: 'threadUpdated', threadId }])
    expect(db.prepare('SELECT model, message_id FROM usage_records').get()).toEqual({
      model: 'claude-haiku-new',
      message_id: null
    })
  })

  it('手動で変更したタイトルは上書きしない', async () => {
    ops.updateThread(db, threadId, { title: '自分で付けた名前', title_source: 'manual' })
    await generator('別の名前').generate(threadId, 'a', 'b', 'claude-sonnet-x')
    expect(calls).toHaveLength(0)
    expect(ops.getThread(db, threadId)!.title).toBe('自分で付けた名前')
  })

  it('生成結果を整える', () => {
    expect(cleanTitle('タイトル：「予算の見直し」')).toBe('予算の見直し')
    expect(cleanTitle('\n\n# 会議の議事録。\n補足')).toBe('会議の議事録')
    expect(cleanTitle('   ')).toBeNull()
    expect([...cleanTitle('あ'.repeat(40))!].length).toBe(31)
  })
})
