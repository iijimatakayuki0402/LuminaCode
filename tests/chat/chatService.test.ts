import type Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activePath } from '../../src/shared/conversation'
import type { ChatEvent, Message } from '../../src/shared/types'
import { AttachmentStore } from '../../src/main/chat/attachments'
import { ChatService, MAX_RETRIES } from '../../src/main/chat/chatService'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { ModelService } from '../../src/main/models/modelService'
import { apiError } from '../helpers/fakeAnthropic'
import { fakeChatClient, type FakeChat, type StreamBehavior } from '../helpers/fakeStream'

const ADAPTIVE = 'claude-sonnet-test'
const LEGACY = 'claude-haiku-test'

let db: Database.Database
let dir: string
let events: ChatEvent[]
let fake: FakeChat
let apiKey: string | null
let sleeps: number[]
let attachments: AttachmentStore
let service: ChatService
let projectId: string
let threadId: string

function setup(behaviors: StreamBehavior[]): void {
  fake = fakeChatClient(behaviors)
}

beforeEach(() => {
  db = createInMemoryDatabase()
  dir = mkdtempSync(join(tmpdir(), 'lumina-chat-'))
  events = []
  sleeps = []
  apiKey = 'sk-test'
  setup([{ chunks: ['こんにちは', '！'] }])
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  ops.setSetting(
    db,
    'models_cache',
    JSON.stringify({
      fetched_at: Date.now(),
      models: [
        {
          id: ADAPTIVE,
          display_name: 'S',
          created_at: '2026-01-01',
          max_input_tokens: 1e6,
          max_tokens: 128000,
          supports_adaptive_thinking: true
        },
        {
          id: LEGACY,
          display_name: 'H',
          created_at: '2025-01-01',
          max_input_tokens: 2e5,
          max_tokens: 8192,
          supports_adaptive_thinking: false
        }
      ]
    })
  )
  ops.setSetting(db, 'default_model', ADAPTIVE)

  attachments = new AttachmentStore(join(dir, 'attachments'))
  service = new ChatService({
    db,
    attachments,
    modelService: new ModelService(db, () => null),
    getApiKey: () => apiKey,
    createClient: () => fake.client,
    emit: (e) => events.push(e),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    flushIntervalMs: 1
  })

  const project = ops.createProject(db, {
    type: 'chat',
    name: 'P',
    custom_instructions: '丁寧に答えて'
  })
  projectId = project.id
  threadId = ops.createThread(db, { project_id: project.id }).id
})

afterEach(async () => {
  await service.whenIdle()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const finished = (): Extract<ChatEvent, { type: 'finished' }>[] =>
  events.filter((e): e is Extract<ChatEvent, { type: 'finished' }> => e.type === 'finished')

const path = (): Message[] => activePath(service.listMessages(threadId))

async function sendAndWait(content: string, attachmentIds: string[] = []): Promise<Message> {
  const { assistantMessage } = service.send({ threadId, content, attachmentIds })
  await service.whenIdle(threadId)
  return service.listMessages(threadId).find((m) => m.id === assistantMessage.id)!
}

describe('送信とストリーミング（CHT-02、CHT-03）', () => {
  it('応答をストリーミングで通知し、完了した内容を保存する', async () => {
    setup([{ chunks: ['こんにちは', '！'], thinking: '挨拶を返す' }])
    const { userMessage, assistantMessage } = service.send({
      threadId,
      content: 'やあ',
      attachmentIds: []
    })

    expect(userMessage).toMatchObject({ role: 'user', content: 'やあ', status: 'complete' })
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      status: 'streaming',
      model: ADAPTIVE
    })
    expect(service.isGenerating(threadId)).toBe(true)

    await service.whenIdle(threadId)

    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)
    expect(text.join('')).toBe('こんにちは！')
    expect(events.some((e) => e.type === 'thinking')).toBe(true)

    const [done] = finished()
    expect(done.errorMessage).toBeNull()
    expect(done.message).toMatchObject({
      status: 'complete',
      content: 'こんにちは！',
      thinking: '挨拶を返す',
      stop_reason: 'end_turn',
      tokens_used: 120
    })
    expect(done.message).not.toHaveProperty('content_blocks')
    expect(service.isGenerating(threadId)).toBe(false)
  })

  it('使用量と概算コストを記録し、スレッドのタイトルを最初の発言から付ける', async () => {
    ops.setSetting(db, 'default_model', 'claude-sonnet-5-5')
    ops.setSetting(
      db,
      'models_cache',
      JSON.stringify({
        fetched_at: Date.now(),
        models: [
          {
            id: 'claude-sonnet-5-5',
            display_name: 'S',
            created_at: 'x',
            max_input_tokens: 1,
            max_tokens: 1,
            supports_adaptive_thinking: true
          }
        ]
      })
    )
    setup([{ chunks: ['ok'], usage: { input_tokens: 1000, output_tokens: 500 } }])

    const message = await sendAndWait('今日の予定を整理したい\n詳細は…')

    // $2/MTok × 1000 + $10/MTok × 500
    expect(message.estimated_cost).toBeCloseTo(0.007, 6)
    const usage = db.prepare('SELECT * FROM usage_records').all() as {
      project_id: string
      input_tokens: number
    }[]
    expect(usage).toMatchObject([{ project_id: projectId, input_tokens: 1000 }])
    expect(ops.getThread(db, threadId)!.title).toBe('今日の予定を整理したい')
  })

  it('完了した応答は内容ブロック（思考ブロックを含む）を変更せずに送り返す', async () => {
    setup([{ chunks: ['A1'], thinking: '考え' }, { chunks: ['A2'] }])
    await sendAndWait('Q1')
    await sendAndWait('Q2')

    const second = fake.calls[1]
    expect(second.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Q1' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '考え', signature: 'sig-abc' },
          { type: 'text', text: 'A1', citations: null }
        ]
      },
      { role: 'user', content: [{ type: 'text', text: 'Q2' }] }
    ])
  })

  it('adaptive thinking 対応モデルでは drop_block を指定し、カスタム指示とキャッシュを付ける', async () => {
    await sendAndWait('Q')
    expect(fake.calls[0]).toMatchObject({
      model: ADAPTIVE,
      max_tokens: 64000,
      system: '丁寧に答えて',
      cache_control: { type: 'ephemeral' },
      thinking: {
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      },
      betas: ['thinking-binding-controls-2026-08-01']
    })
  })

  it('非対応モデルでは thinking を指定せず、max_tokens はモデルの上限に合わせる', async () => {
    ops.updateThread(db, threadId, { model: LEGACY })
    await sendAndWait('Q')
    expect(fake.calls[0].model).toBe(LEGACY)
    expect(fake.calls[0].max_tokens).toBe(8192)
    expect(fake.calls[0]).not.toHaveProperty('thinking')
    expect(fake.calls[0]).not.toHaveProperty('betas')
  })
})

describe('停止（CHT-04）', () => {
  it('停止時点までの本文を保持し、次の送信では本文だけを送る', async () => {
    setup([{ chunks: ['途中まで'], hang: true }, { chunks: ['次'] }])
    service.send({ threadId, content: 'Q1', attachmentIds: [] })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'text')).toBe(true))

    service.stop(threadId)
    await service.whenIdle(threadId)

    expect(finished()[0].message).toMatchObject({ status: 'stopped', content: '途中まで' })
    expect(ops.getMessage(db, finished()[0].message.id)!.content_blocks).toBeNull()

    await sendAndWait('Q2')
    expect(fake.calls[1].messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '途中まで' }]
    })
  })
})

describe('エラーとリトライ（6.14）', () => {
  it('混雑（529）は待機して再試行し、待機中であることを通知する', async () => {
    setup([{ error: apiError(529, 'overloaded_error') }, { chunks: ['ok'] }])
    const message = await sendAndWait('Q')

    expect(message.status).toBe('complete')
    const retry = events.find((e) => e.type === 'retrying')
    expect(retry).toMatchObject({ attempt: 1, maxAttempts: MAX_RETRIES, waitMs: 2000 })
    expect(sleeps).toEqual([2000])
  })

  it(`最大 ${MAX_RETRIES} 回まで再試行し、それでも失敗したらエラーとして保存する`, async () => {
    setup([{ error: apiError(429, 'rate_limit_error') }])
    const message = await sendAndWait('Q')

    expect(fake.calls).toHaveLength(MAX_RETRIES + 1)
    expect(sleeps).toEqual([2000, 4000, 8000])
    expect(message).toMatchObject({ status: 'error', error_kind: 'rate_limit' })
    expect(finished()[0].errorMessage).toContain('上限')
  })

  it('認証エラー（401）は再試行しない', async () => {
    setup([{ error: apiError(401, 'authentication_error') }])
    const message = await sendAndWait('Q')

    expect(fake.calls).toHaveLength(1)
    expect(message).toMatchObject({ status: 'error', error_kind: 'auth' })
  })

  it('エラー後に再生成できる', async () => {
    setup([{ error: apiError(401, 'authentication_error') }, { chunks: ['復旧'] }])
    const failed = await sendAndWait('Q')
    const user = path()[0]

    service.regenerate(user.id)
    await service.whenIdle(threadId)

    const current = path()
    expect(current.map((m) => m.content)).toEqual(['Q', '復旧'])
    // 失敗した応答は分岐履歴として残る
    expect(service.listMessages(threadId).some((m) => m.id === failed.id)).toBe(true)
    // 再送信には失敗した応答を含めない
    expect(fake.calls[1].messages).toHaveLength(1)
  })

  it('起動時に生成中のまま残った応答を中断にする', () => {
    const user = ops.createMessage(db, { thread_id: threadId, role: 'user', content: 'Q' })
    ops.createMessage(db, {
      thread_id: threadId,
      parent_id: user.id,
      role: 'assistant',
      content: '',
      status: 'streaming'
    })

    expect(service.recoverInterrupted()).toBe(1)
    expect(path()[1].status).toBe('interrupted')
  })
})

describe('送信前の確認', () => {
  it('生成中・Cowork・キー未設定・モデル未選択・空の入力は送信できない', async () => {
    setup([{ chunks: ['x'], hang: true }])
    service.send({ threadId, content: 'Q', attachmentIds: [] })
    expect(() => service.send({ threadId, content: 'Q2', attachmentIds: [] })).toThrow('生成中')
    service.stop(threadId)
    await service.whenIdle(threadId)

    expect(() => service.send({ threadId, content: '  ', attachmentIds: [] })).toThrow('入力')

    const cowork = ops.createProject(db, { type: 'cowork', name: 'C', work_folder: dir })
    const coworkThread = ops.createThread(db, { project_id: cowork.id })
    expect(() =>
      service.send({ threadId: coworkThread.id, content: 'Q', attachmentIds: [] })
    ).toThrow('Cowork')

    ops.deleteSetting(db, 'default_model')
    expect(() => service.send({ threadId, content: 'Q', attachmentIds: [] })).toThrow('モデル')

    apiKey = null
    expect(() => service.send({ threadId, content: 'Q', attachmentIds: [] })).toThrow('API キー')
  })
})

describe('編集して再送信（CHT-14）', () => {
  it('最新のユーザーメッセージを編集すると、分岐として新しい会話になる', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A2'] }, { chunks: ['A2改'] }])
    await sendAndWait('Q1')
    await sendAndWait('Q2')
    const q2 = path()[2]

    service.editAndResend({
      userMessageId: q2.id,
      content: 'Q2改',
      keepAttachmentIds: [],
      attachmentIds: []
    })
    await service.whenIdle(threadId)

    expect(path().map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2改', 'A2改'])
    // 旧版は残る
    expect(service.listMessages(threadId).map((m) => m.content)).toContain('A2')
    // 再送信の履歴には旧版を含めない
    expect(fake.calls[2].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('最新以外のメッセージは編集できない', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A2'] }])
    await sendAndWait('Q1')
    await sendAndWait('Q2')

    expect(() =>
      service.editAndResend({
        userMessageId: path()[0].id,
        content: 'x',
        keepAttachmentIds: [],
        attachmentIds: []
      })
    ).toThrow('最新')
  })

  it('添付ファイルを残す・外す・追加することができる', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A2'] }])
    const a = attachments.stageFromData('a.txt', Buffer.from('AAA'))
    const b = attachments.stageFromData('b.txt', Buffer.from('BBB'))
    await sendAndWait('Q', [a.id, b.id])
    const original = path()[0]
    const kept = original.attachments.find((x) => x.filename === 'a.txt')!
    const c = attachments.stageFromData('c.md', Buffer.from('# C'))

    service.editAndResend({
      userMessageId: original.id,
      content: 'Q改',
      keepAttachmentIds: [kept.id],
      attachmentIds: [c.id]
    })
    await service.whenIdle(threadId)

    expect(path()[0].attachments.map((x) => x.filename)).toEqual(['a.txt', 'c.md'])
    const titles = (fake.calls[1].messages[0].content as { title?: string }[]).map((x) => x.title)
    expect(titles).toEqual(['a.txt', 'c.md', undefined])
  })
})

describe('添付ファイル（CHT-01、ATT-01〜04）', () => {
  it('画像・PDF・テキストを内容ブロックにして送り、保存先にコピーして保持する', async () => {
    const png = attachments.stageFromData('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const pdf = attachments.stageFromData('doc.pdf', Buffer.from('%PDF-1.4'))
    const txt = attachments.stageFromData('memo.md', Buffer.from('メモ'))
    expect(png.preview).toMatch(/^data:image\/png;base64,/)

    await sendAndWait('これを見て', [png.id, pdf.id, txt.id])

    expect(fake.calls[0].messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
      {
        type: 'document',
        title: 'doc.pdf',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('%PDF-1.4').toString('base64')
        }
      },
      {
        type: 'document',
        title: 'memo.md',
        source: { type: 'text', media_type: 'text/plain', data: 'メモ' }
      },
      { type: 'text', text: 'これを見て' }
    ])
    const user = path()[0]
    expect(user.attachments.map((x) => x.kind)).toEqual(['image', 'pdf', 'text'])
    expect(readdirSync(join(dir, 'attachments', user.id))).toHaveLength(3)
  })

  it('添付ファイルだけでも送信できる', async () => {
    const txt = attachments.stageFromData('a.txt', Buffer.from('x'))
    const message = await sendAndWait('', [txt.id])
    expect(message.status).toBe('complete')
    expect(fake.calls[0].messages[0].content).toHaveLength(1)
  })

  it('11 個以上は送信できない', () => {
    const ids = Array.from(
      { length: 11 },
      (_, i) => attachments.stageFromData(`${i}.txt`, Buffer.from('x')).id
    )
    expect(() => service.send({ threadId, content: 'Q', attachmentIds: ids })).toThrow('10 個')
  })

  it('対応外・Office・空・UTF-8 以外・大きすぎる画像は仮置きできない', () => {
    expect(() => attachments.stageFromData('a.exe', Buffer.from('x'))).toThrow('形式')
    expect(() => attachments.stageFromData('a.docx', Buffer.from('x'))).toThrow('Office')
    expect(() => attachments.stageFromData('a.txt', Buffer.alloc(0))).toThrow('空')
    expect(() => attachments.stageFromData('a.txt', Buffer.from([0xff, 0xfe, 0x00]))).toThrow(
      'UTF-8'
    )
    expect(() => attachments.stageFromData('a.png', Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow(
      '画像'
    )
  })

  it('仮置きを取り消せる（ATT-05）', () => {
    const txt = attachments.stageFromData('a.txt', Buffer.from('x'))
    attachments.discard(txt.id)
    expect(() => service.send({ threadId, content: 'Q', attachmentIds: [txt.id] })).toThrow(
      '見つかりません'
    )
  })
})

describe('activePath', () => {
  it('各階層で最も新しい子を辿る', () => {
    const nodes = [
      { id: 'q1', parent_id: null },
      { id: 'a1', parent_id: 'q1' },
      { id: 'q2', parent_id: 'a1' },
      { id: 'a2', parent_id: 'q2' },
      { id: 'q2b', parent_id: 'a1' },
      { id: 'a2b', parent_id: 'q2b' }
    ]
    expect(activePath(nodes).map((n) => n.id)).toEqual(['q1', 'a1', 'q2b', 'a2b'])
    expect(activePath([])).toEqual([])
  })

  it('完了の通知を受けてすぐに次を送信できる', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A2'] }])
    let followUp: unknown = 'not called'
    const deps = (service as unknown as { deps: { emit: (e: ChatEvent) => void } }).deps
    const base = deps.emit
    deps.emit = (e) => {
      base(e)
      if (e.type === 'finished' && followUp === 'not called') {
        try {
          service.send({ threadId, content: 'Q2', attachmentIds: [] })
          followUp = null
        } catch (error) {
          followUp = error
        }
      }
    }
    await sendAndWait('Q1')
    await service.whenIdle(threadId)
    expect(followUp).toBeNull()
    expect(path().map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', 'A2'])
  })
})
