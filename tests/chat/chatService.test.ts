import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activePath, leafFrom, siblingsOf } from '../../src/shared/conversation'
import type { ChatEvent, Message } from '../../src/shared/types'
import { AttachmentStore } from '../../src/main/chat/attachments'
import { ChatService, MAX_RETRIES } from '../../src/main/chat/chatService'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { ModelService } from '../../src/main/models/modelService'
import { apiError } from '../helpers/fakeAnthropic'
import { offCandidates } from '../../src/main/chat/thinking'
import { estimateCost } from '../../src/main/chat/pricing'

/** 思考の指定がモデルに受け付けられなかったときの 400 */
const thinkingError = (): InstanceType<typeof Anthropic.APIError> =>
  Anthropic.APIError.generate(
    400,
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'thinking.type: not supported for this model'
      }
    },
    'thinking.type: not supported for this model',
    new Headers()
  )
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
let webSearch: boolean

function setup(behaviors: StreamBehavior[]): void {
  fake = fakeChatClient(behaviors)
}

beforeEach(() => {
  db = createInMemoryDatabase()
  dir = mkdtempSync(join(tmpdir(), 'lumina-chat-'))
  events = []
  sleeps = []
  apiKey = 'sk-test'
  webSearch = false
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
          supports_adaptive_thinking: true,
          effort_levels: ['low', 'medium', 'high']
        },
        {
          id: LEGACY,
          display_name: 'H',
          created_at: '2025-01-01',
          max_input_tokens: 2e5,
          max_tokens: 8192,
          supports_adaptive_thinking: false,
          effort_levels: []
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
    isWebSearchEnabled: () => webSearch,
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

const path = (): Message[] =>
  activePath(service.listMessages(threadId), ops.getThread(db, threadId)?.active_leaf_id)

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
      system: '# プロジェクトのカスタム指示\n丁寧に答えて',
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

  it('最新以外のメッセージも編集でき、その位置から分岐する（CHT-06）', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A2'] }, { chunks: ['A1改'] }])
    await sendAndWait('Q1')
    await sendAndWait('Q2')

    service.editAndResend({
      userMessageId: path()[0].id,
      content: 'Q1改',
      keepAttachmentIds: [],
      attachmentIds: []
    })
    await service.whenIdle(threadId)

    expect(path().map((m) => m.content)).toEqual(['Q1改', 'A1改'])
    expect(fake.calls[2].messages).toHaveLength(1)
  })

  it('表示中の分岐に戻すと、その続きから送信できる（CHT-06）', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A1改'] }, { chunks: ['続き'] }])
    await sendAndWait('Q1')
    const first = path()
    service.editAndResend({
      userMessageId: first[0].id,
      content: 'Q1改',
      keepAttachmentIds: [],
      attachmentIds: []
    })
    await service.whenIdle(threadId)

    // 元の分岐に戻す
    const records = ops.listMessagesByThread(db, threadId)
    ops.updateThread(db, threadId, { active_leaf_id: leafFrom(records, first[0].id) })
    expect(path().map((m) => m.content)).toEqual(['Q1', 'A1'])
    const { siblings, index } = siblingsOf(service.listMessages(threadId), path()[0])
    expect([siblings.length, index]).toEqual([2, 0])

    await sendAndWait('Q2')
    expect(path().map((m) => m.content)).toEqual(['Q1', 'A1', 'Q2', '続き'])
    expect(fake.calls[2].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('完了した応答も再生成できる（CHT-06）', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['A1再'] }])
    await sendAndWait('Q1')
    service.regenerate(path()[0].id)
    await service.whenIdle(threadId)
    expect(path().map((m) => m.content)).toEqual(['Q1', 'A1再'])
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

describe('思考量・共通の指示・要約・タイトル（Phase 2）', () => {
  it('思考量はモデルが対応している場合だけ指定する（CHT-07）', async () => {
    setup([{ chunks: ['a'] }, { chunks: ['b'] }])
    ops.updateThread(db, threadId, { effort: 'low' })
    await sendAndWait('Q1')
    expect(fake.calls[0].output_config).toEqual({ effort: 'low' })

    ops.updateThread(db, threadId, { effort: 'max' })
    await sendAndWait('Q2')
    expect(fake.calls[1]).not.toHaveProperty('output_config')
  })

  it('新しいスレッドの拡張思考は既定でオン（CHT-07）', () => {
    expect(ops.getThread(db, threadId)!.extended_thinking).toBe(true)
    const off = ops.createThread(db, { project_id: projectId, extended_thinking: false })
    expect(off.extended_thinking).toBe(false)
  })

  it('拡張思考をオフにすると思考を止める指定を送り、以前の思考ブロックも送らない（CHT-07）', async () => {
    setup([{ chunks: ['A1'], thinking: '考えた' }, { chunks: ['A2'] }])
    await sendAndWait('Q1')
    const stored = ops.getMessage(db, path()[1].id)!.content_blocks
    const blocks = JSON.parse(stored ?? '[]') as { type: string }[]
    expect(blocks.map((b) => b.type)).toContain('thinking')

    ops.updateThread(db, threadId, { extended_thinking: false })
    await sendAndWait('Q2')
    expect(fake.calls[1].thinking).toEqual({ type: 'disabled' })
    expect(fake.calls[1]).not.toHaveProperty('betas')
    const assistant = fake.calls[1].messages.find((m) => m.role === 'assistant')!
    expect((assistant.content as { type: string }[]).map((b) => b.type)).toEqual(['text'])
    // 受け付けられた指定を覚える
    expect(ops.getSetting(db, `thinking.off.${ADAPTIVE}`)).toBe('disabled')
  })

  it('disabled を受け付けないモデルは between_tools を試し、覚えて次から使う（CHT-07）', async () => {
    setup([{ error: thinkingError() }, { chunks: ['A1'] }, { chunks: ['A2'] }])
    ops.updateThread(db, threadId, { extended_thinking: false })
    const m = await sendAndWait('Q1')
    expect(m.status).toBe('complete')
    expect(fake.calls.map((c) => c.thinking)).toEqual([
      { type: 'disabled' },
      { type: 'between_tools' }
    ])
    // 待機・リトライの表示は出さない
    expect(events.some((e) => e.type === 'retrying')).toBe(false)
    await sendAndWait('Q2')
    expect(fake.calls[2].thinking).toEqual({ type: 'between_tools' })
  })

  it('止められないモデルはオンのまま送り、次からは試さない（CHT-07）', async () => {
    setup([
      { error: thinkingError() },
      { error: thinkingError() },
      { chunks: ['A1'] },
      { chunks: ['A2'] }
    ])
    ops.updateThread(db, threadId, { extended_thinking: false })
    expect((await sendAndWait('Q1')).status).toBe('complete')
    expect(fake.calls.map((c) => c.thinking?.type)).toEqual([
      'disabled',
      'between_tools',
      'adaptive'
    ])
    expect(ops.getSetting(db, `thinking.off.${ADAPTIVE}`)).toBe('unsupported')
    await sendAndWait('Q2')
    expect(fake.calls[3].thinking?.type).toBe('adaptive')
  })

  it('思考量が xhigh・max では between_tools を使わず、止められないと決めつけない（CHT-07）', async () => {
    setup([{ error: thinkingError() }, { chunks: ['A1'] }])
    ops.updateThread(db, threadId, { extended_thinking: false, effort: 'high' })
    // ADAPTIVE は low/medium/high のみ対応のため、ここでは offCandidates を直接確かめる
    expect(offCandidates(db, ADAPTIVE, 'max')).toEqual(['disabled'])
    expect(offCandidates(db, ADAPTIVE, 'high')).toEqual(['disabled', 'between_tools'])
  })

  it('共通のカスタム指示 → プロジェクトの順に結合する（PRJ-08）', async () => {
    const service2 = new ChatService({
      db,
      attachments,
      modelService: new ModelService(db, () => null),
      getApiKey: () => 'sk-test',
      createClient: () => fake.client,
      emit: () => undefined,
      getGlobalInstructions: () => '必ず敬語で',
      flushIntervalMs: 1
    })
    service2.send({ threadId, content: 'Q', attachmentIds: [] })
    await service2.whenIdle(threadId)
    const system = String(fake.calls[0].system)
    expect(system.indexOf('必ず敬語で')).toBeLessThan(system.indexOf('丁寧に答えて'))
  })

  it('要約して新しいスレッドで続ける（CTX-02）', async () => {
    setup([{ chunks: ['A1'] }, { chunks: ['これまでの要約'] }, { chunks: ['続きの回答'] }])
    await sendAndWait('Q1')
    const next = await service.compact(threadId)

    expect(next).toMatchObject({ context_summary: 'これまでの要約', project_id: projectId })
    expect(next.title).toContain('（続き）')
    // 要約の依頼は会話の最後にユーザーとして加える
    expect(fake.calls[1].messages.at(-1)!.role).toBe('user')

    service.send({ threadId: next.id, content: 'Q2', attachmentIds: [] })
    await service.whenIdle(next.id)
    expect(String(fake.calls[2].system)).toContain('これまでの要約')
    expect(fake.calls[2].messages).toHaveLength(1)
  })

  it('最初のやり取りの完了後にだけタイトルの自動生成を依頼する（THR-03）', async () => {
    const generate = vi.fn(async () => undefined)
    const service2 = new ChatService({
      db,
      attachments,
      modelService: new ModelService(db, () => null),
      getApiKey: () => 'sk-test',
      createClient: () => fake.client,
      emit: () => undefined,
      titles: { generate },
      flushIntervalMs: 1
    })
    setup([{ chunks: ['A1'] }, { chunks: ['A2'] }])
    service2.send({ threadId, content: '旅行の計画', attachmentIds: [] })
    await service2.whenIdle(threadId)
    service2.send({ threadId, content: '次', attachmentIds: [] })
    await service2.whenIdle(threadId)

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith(threadId, '旅行の計画', 'A1', ADAPTIVE)
    expect(ops.getThread(db, threadId)!.title_source).toBe('auto')
  })
})

describe('Web 検索（CHT-11）', () => {
  it('オンのときだけ検索ツールを渡し、モデルに合った版を使う', async () => {
    setup([{ chunks: ['a'] }, { chunks: ['b'] }, { chunks: ['c'] }])
    await sendAndWait('Q1')
    expect(fake.calls[0]).not.toHaveProperty('tools')

    webSearch = true
    await sendAndWait('Q2')
    expect(fake.calls[1].tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }
    ])
    ops.updateThread(db, threadId, { model: LEGACY })
    await sendAndWait('Q3')
    expect(fake.calls[2].tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
    ])
  })

  it('検索語を知らせ、出典を回答に付け、検索の料金を概算コストに含める', async () => {
    webSearch = true
    setup([
      {
        chunks: ['東京は晴れです。'],
        search: {
          query: '東京 天気',
          requests: 2,
          citations: [
            { url: 'https://example.com/a', title: 'A' },
            { url: 'https://example.com/a', title: 'A' },
            { url: 'https://example.com/b', title: 'B' }
          ]
        }
      }
    ])
    const m = await sendAndWait('天気は？')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'webSearch', query: '東京 天気' })
    )
    expect(m.sources).toEqual([
      { url: 'https://example.com/a', title: 'A', cited: true },
      { url: 'https://example.com/b', title: 'B', cited: true }
    ])
    // 検索の回数は概算コストに含める（1 回 0.01 USD）
    const base = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    expect(estimateCost('claude-sonnet-5-5', { ...base, web_search_requests: 2 })).toBeCloseTo(
      0.02,
      6
    )
  })

  it('結果を絞り込む版: コード実行は数えず検索語を出し、引用が無ければ検索結果を示す', async () => {
    webSearch = true
    setup([
      {
        chunks: ['答え'],
        search: {
          query: '最新 モデル',
          filtered: true,
          results: [
            { url: 'https://example.com/x', title: 'X' },
            { url: 'https://example.com/x', title: 'X' }
          ]
        }
      }
    ])
    const m = await sendAndWait('Q')
    expect(events.filter((e) => e.type === 'webSearch')).toEqual([
      expect.objectContaining({ query: '最新 モデル' })
    ])
    expect(m.sources).toEqual([{ url: 'https://example.com/x', title: 'X', cited: false }])
  })

  it('pause_turn では、それまでの応答を付けて続きを頼み、1 つの回答にまとめる', async () => {
    webSearch = true
    setup([
      { chunks: ['前半'], stopReason: 'pause_turn', search: { query: 'q' } },
      { chunks: ['後半'] }
    ])
    const m = await sendAndWait('Q')
    expect(fake.calls).toHaveLength(2)
    const last = fake.calls[1].messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect((last.content as { type: string }[]).map((b) => b.type)).toContain('server_tool_use')
    expect(m.content).toBe('前半後半')
    expect(m.status).toBe('complete')
    // 使用量は 2 回分を足す
    expect(m.tokens_used).toBe(240)
  })

  it('オフにした後も以前の検索結果は残し、検索ツールは使わせない（tool_choice: none）', async () => {
    webSearch = true
    setup([{ chunks: ['A1'], search: { query: 'q' } }, { chunks: ['A2'] }, { chunks: ['A3'] }])
    await sendAndWait('Q1')
    webSearch = false
    await sendAndWait('Q2')
    const assistant = fake.calls[1].messages.find((x) => x.role === 'assistant')!
    expect((assistant.content as { type: string }[]).map((b) => b.type)).toContain(
      'server_tool_use'
    )
    expect(fake.calls[1].tools).toHaveLength(1)
    expect(fake.calls[1].tool_choice).toEqual({ type: 'none' })
    // 検索していないスレッドでは、ツールを渡さない
    const other = ops.createThread(db, { project_id: projectId }).id
    service.send({ threadId: other, content: 'Q', attachmentIds: [] })
    await service.whenIdle(other)
    expect(fake.calls[2]).not.toHaveProperty('tools')
    expect(fake.calls[2]).not.toHaveProperty('tool_choice')
  })
})
