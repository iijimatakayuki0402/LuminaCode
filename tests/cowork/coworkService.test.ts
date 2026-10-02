import type Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activePath } from '../../src/shared/conversation'
import type { ChatEvent, PermissionRequest, PermissionResponse } from '../../src/shared/types'
import { CoworkService } from '../../src/main/cowork/coworkService'
import { DELETE_TOOL } from '../../src/main/cowork/policy'
import { listTrash } from '../../src/main/cowork/trash'
import { setCoworkSettings, setSkillsTrust } from '../../src/main/cowork/extensions'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { ModelService } from '../../src/main/models/modelService'
import { fakeAgentSdk, type FakeAgent, type Script } from '../helpers/fakeAgentSdk'

let db: Database.Database
let base: string
let work: string
let events: ChatEvent[]
let fake: FakeAgent
let service: CoworkService
let projectId: string
let threadId: string
/** 確認ダイアログに自動で返す回答 */
let answer: PermissionResponse

function setup(scripts: Script[]): void {
  fake = fakeAgentSdk(scripts)
  service = new CoworkService({
    db,
    snapshotsDir: join(base, 'snapshots'),
    modelService: new ModelService(db, () => null),
    getApiKey: () => 'sk-test',
    configDir: join(base, 'agent'),
    loadSdk: fake.loadSdk,
    emit: (e) => {
      events.push(e)
      if (e.type === 'permission')
        queueMicrotask(() => service.respond(e.request.requestId, answer))
    }
  })
}

beforeEach(() => {
  db = createInMemoryDatabase()
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'lumina-cowork-')))
  work = join(base, 'work')
  mkdirSync(work)
  writeFileSync(join(work, 'a.txt'), 'before')
  writeFileSync(join(base, 'outside.txt'), 'secret')
  events = []
  answer = 'once'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ops.setSetting(db, 'default_model', 'claude-sonnet-test')
  const project = ops.createProject(db, { type: 'cowork', name: 'C', work_folder: work })
  projectId = project.id
  threadId = ops.createThread(db, { project_id: projectId }).id
  setup([{ text: 'done' }])
})

afterEach(async () => {
  await service.whenIdle()
  db.close()
  rmSync(base, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function send(content = '作業して'): Promise<string> {
  const { assistantMessage } = service.send({ threadId, content, attachmentIds: [] })
  await service.whenIdle(threadId)
  return assistantMessage.id
}

const permissions = (): PermissionRequest[] =>
  events
    .filter((e): e is Extract<ChatEvent, { type: 'permission' }> => e.type === 'permission')
    .map((e) => e.request)
const methods = (): string[] =>
  service.listToolEvents(threadId).map((e) => `${e.tool_name}:${e.permission_method}`)
const decisions = (): string[] => fake.runs.at(-1)!.decisions.map((d) => `${d.tool}:${d.decision}`)

describe('実行環境（Phase 0 の注意事項、SEC-33）', () => {
  it('認証情報・テレメトリ・ユーザー設定を持ち込まない', async () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'leak'
    process.env['AWS_PROFILE'] = 'leak'
    try {
      await send()
    } finally {
      delete process.env['ANTHROPIC_AUTH_TOKEN']
      delete process.env['AWS_PROFILE']
    }
    const { options } = fake.runs[0]
    expect(options.env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CONFIG_DIR: join(base, 'agent'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1'
    })
    expect(options.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(options.env).not.toHaveProperty('AWS_PROFILE')
    expect(options).toMatchObject({
      cwd: work,
      model: 'claude-sonnet-test',
      settingSources: [],
      permissionMode: 'default',
      disallowedTools: ['WebSearch', 'WebFetch'],
      // Claude Code の組み込みのスキルも使わない
      skills: []
    })
    expect(options.tools).not.toContain('WebFetch')
  })

  it('作業フォルダの CLAUDE.md とカスタム指示をシステムプロンプトに加える（COW-11）', async () => {
    writeFileSync(join(work, 'CLAUDE.md'), 'テストは必ず書く')
    ops.updateProject(db, projectId, { custom_instructions: '丁寧に' })
    await send()
    const append = (fake.runs[0].options.systemPrompt as { append: string }).append
    expect(append).toContain('テストは必ず書く')
    expect(append).toContain('丁寧に')
    expect(append).toContain(DELETE_TOOL)
  })

  it('拡張思考をオフにしたスレッドでは思考を無効にする（CHT-07）', async () => {
    const model = {
      id: 'claude-sonnet-test',
      display_name: 'S',
      created_at: '2026-01-01',
      max_input_tokens: 1e6,
      max_tokens: 128000,
      supports_adaptive_thinking: true,
      effort_levels: ['low']
    }
    ops.setSetting(db, 'models_cache', JSON.stringify({ fetched_at: Date.now(), models: [model] }))
    await send()
    expect(fake.runs[0].options).not.toHaveProperty('thinking')

    ops.updateThread(db, threadId, { extended_thinking: false })
    await send()
    expect(fake.runs[1].options.thinking).toEqual({ type: 'disabled' })
  })

  it('TodoWrite の内容を todo のパネルに送る（COW-13）', async () => {
    const todos = [
      { content: '調べる', status: 'completed', activeForm: '調べています' },
      { content: '直す', status: 'in_progress', activeForm: '直しています' }
    ]
    setup([{ todos, text: 'done' }])
    const id = await send()
    expect(events.filter((e) => e.type === 'todos')).toEqual([
      { type: 'todos', threadId, messageId: id, todos }
    ])
    expect(fake.runs[0].options.tools).toContain('TodoWrite')
  })

  it('完了した内容と使用量を記録する', async () => {
    const id = await send()
    expect(ops.getMessage(db, id)).toMatchObject({
      status: 'complete',
      content: 'done',
      estimated_cost: 0.0123
    })
    expect(db.prepare('SELECT estimated_cost FROM usage_records').get()).toEqual({
      estimated_cost: 0.0123
    })
  })

  it('作業フォルダが無いときは実行しない（PRJ-06）', () => {
    rmSync(work, { recursive: true, force: true })
    expect(() => service.send({ threadId, content: 'x', attachmentIds: [] })).toThrow(
      '作業フォルダが見つかりません'
    )
  })
})

describe('権限モードと確認（6.7、受け入れ基準 6）', () => {
  it('毎回確認: 読み取りは自動、書き込みは確認して実行し、すべて記録する（LOG-01）', async () => {
    setup([
      {
        calls: [
          { tool: 'Read', input: { file_path: join(work, 'a.txt') } },
          { tool: 'Write', input: { file_path: join(work, 'b.txt'), content: 'new' } }
        ],
        text: 'ok'
      }
    ])
    await send()

    expect(decisions()).toEqual(['Read:allow', 'Write:allow'])
    expect(permissions()).toHaveLength(1)
    expect(permissions()[0]).toMatchObject({
      toolName: 'Write',
      category: 'write',
      detail: 'new',
      offerAlways: true
    })
    expect(permissions()[0].targets).toEqual([{ path: 'b.txt', kind: 'missing', size_bytes: null }])
    expect(readFileSync(join(work, 'b.txt'), 'utf-8')).toBe('new')
    expect(methods()).toEqual(['Read:auto', 'Write:allowed_once'])
    expect(service.listToolEvents(threadId)[0]).toMatchObject({ target: 'a.txt', result: 'before' })
  })

  it('拒否するとファイルは変更されない', async () => {
    answer = 'deny'
    setup([
      {
        calls: [
          { tool: 'Edit', input: { file_path: 'a.txt', old_string: 'before', new_string: 'after' } }
        ]
      }
    ])
    await send()
    expect(decisions()).toEqual(['Edit:deny'])
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('before')
    expect(methods()).toEqual(['Edit:denied'])
  })

  it('作業フォルダ外へのアクセスは確認せずに拒否し、ログに残す（SEC-03）', async () => {
    setup([
      {
        calls: [
          { tool: 'Read', input: { file_path: join(base, 'outside.txt') } },
          { tool: 'Write', input: { file_path: '../outside.txt', content: 'x' } }
        ]
      }
    ])
    await send()
    expect(decisions()).toEqual(['Read:deny', 'Write:deny'])
    expect(permissions()).toHaveLength(0)
    expect(readFileSync(join(base, 'outside.txt'), 'utf-8')).toBe('secret')
    expect(service.listToolEvents(threadId).every((e) => e.result?.startsWith('拒否'))).toBe(true)
  })

  it('このスレッドでは常に許可 → 次から自動許可。解除すると再び確認する', async () => {
    answer = 'thread'
    setup([
      {
        calls: [
          { tool: 'Write', input: { file_path: 'x.txt', content: '1' } },
          { tool: 'Write', input: { file_path: 'y.txt', content: '2' } }
        ]
      }
    ])
    await send()
    expect(permissions()).toHaveLength(1)
    expect(methods()).toEqual(['Write:allowed_always_thread', 'Write:allowed_always_thread'])
    expect(service.getAlways(projectId, threadId).thread).toEqual(['write'])

    service.clearAlways('thread', threadId)
    setup([{ calls: [{ tool: 'Write', input: { file_path: 'z.txt', content: '3' } }] }])
    await send('もう一度')
    expect(permissions()).toHaveLength(2)
  })

  it('計画のみ: plan モードで実行し、変更はすべて拒否する', async () => {
    ops.updateProject(db, projectId, { permission_mode: 'plan_only' })
    setup([
      {
        calls: [
          { tool: 'Read', input: { file_path: 'a.txt' } },
          { tool: 'Write', input: { file_path: 'a.txt', content: 'x' } },
          { tool: 'Bash', input: { command: 'git status' } }
        ]
      }
    ])
    await send()
    expect(fake.runs[0].options.permissionMode).toBe('plan')
    expect(decisions()).toEqual(['Read:allow', 'Write:deny', 'Bash:deny'])
    expect(permissions()).toHaveLength(0)
  })

  it('コマンド: 拒否リスト・コマンドでの削除は確認せずに拒否する', async () => {
    setup([
      {
        calls: [
          { tool: 'PowerShell', input: { command: 'format C:' } },
          { tool: 'Bash', input: { command: 'rm a.txt' } }
        ]
      }
    ])
    await send()
    expect(decisions()).toEqual(['PowerShell:deny', 'Bash:deny'])
    expect(fake.runs[0].decisions[1].reason).toContain(DELETE_TOOL)
    expect(existsSync(join(work, 'a.txt'))).toBe(true)
  })
})

describe('削除・スナップショット・Undo（9.2、受け入れ基準 8・9）', () => {
  it('削除は確認のうえ .lumina-trash に退避し、元に戻せる', async () => {
    setup([{ calls: [{ tool: DELETE_TOOL, input: { paths: ['a.txt'] } }], text: '削除しました' }])
    const runId = await send()

    expect(permissions()[0]).toMatchObject({
      category: 'delete',
      targets: [{ path: 'a.txt', kind: 'file', size_bytes: 6 }]
    })
    expect(existsSync(join(work, 'a.txt'))).toBe(false)
    expect(listTrash(work).map((e) => e.originalPath)).toEqual(['a.txt'])
    expect(service.listChanges(runId)).toMatchObject([
      { path: 'a.txt', kind: 'trashed', restored: false }
    ])

    expect(service.undo(runId)).toEqual({ restored: ['a.txt'], skipped: [] })
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('before')
    expect(listTrash(work)).toEqual([])
  })

  it('変更前の内容を保存し、実行単位でまとめて元に戻す（新規作成は退避する）', async () => {
    answer = 'thread'
    setup([
      {
        calls: [
          {
            tool: 'Edit',
            input: { file_path: 'a.txt', old_string: 'before', new_string: 'after' }
          },
          {
            tool: 'Edit',
            input: { file_path: 'a.txt', old_string: 'after', new_string: 'after2' }
          },
          { tool: 'Write', input: { file_path: 'sub/new.txt', content: 'created' } }
        ]
      }
    ])
    const runId = await send()
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('after2')
    expect(service.listChanges(runId).map((c) => `${c.kind}:${c.path}`)).toEqual([
      'modified:a.txt',
      `created:${join('sub', 'new.txt')}`
    ])

    const diff = service.diff(service.listChanges(runId)[0].snapshotId)
    expect(diff).toMatchObject({ before: 'before', after: 'after2', binary: false })

    service.undo(runId)
    expect(readFileSync(join(work, 'a.txt'), 'utf-8')).toBe('before')
    expect(existsSync(join(work, 'sub', 'new.txt'))).toBe(false)
    expect(listTrash(work).map((e) => e.originalPath)).toEqual([join('sub', 'new.txt')])
    expect(service.listChanges(runId).every((c) => c.restored)).toBe(true)
  })

  it('.git の削除は常に許可を選べない専用の確認になる（SEC-04）', async () => {
    mkdirSync(join(work, '.git'))
    setup([{ calls: [{ tool: DELETE_TOOL, input: { paths: ['.git'] } }] }])
    answer = 'deny'
    await send()
    expect(permissions()[0]).toMatchObject({
      offerAlways: false,
      danger: expect.stringContaining('.git')
    })
    expect(existsSync(join(work, '.git'))).toBe(true)
  })
})

describe('中断と再開（COW-06、CHT-14）', () => {
  it('確認待ちの間に中断すると拒否扱いで止まり、それまでの変更は残る', async () => {
    answer = 'once'
    setup([{ calls: [{ tool: 'Write', input: { file_path: 'x.txt', content: '1' } }], hang: true }])
    const { assistantMessage } = service.send({ threadId, content: 'x', attachmentIds: [] })
    await vi.waitFor(() => expect(existsSync(join(work, 'x.txt'))).toBe(true))
    service.stop(threadId)
    await service.whenIdle(threadId)
    expect(ops.getMessage(db, assistantMessage.id)!.status).toBe('stopped')
    expect(service.listChanges(assistantMessage.id)).toHaveLength(1)
  })

  it('次の指示は同じセッションを再開し、編集・再実行は直前まで巻き戻して分岐する', async () => {
    setup([{ text: '1回目' }, { text: '2回目' }, { text: '2回目（編集後）' }])
    await send('最初の指示')
    await send('次の指示')
    expect(fake.runs[1].options.resume).toBe('session-1')
    expect(fake.runs[1].options.forkSession).toBeUndefined()

    const path = activePath(ops.listMessagesByThread(db, threadId))
    service.editAndResend({
      userMessageId: path[2].id,
      content: '次の指示（修正）',
      keepAttachmentIds: [],
      attachmentIds: []
    })
    await service.whenIdle(threadId)
    expect(fake.runs[2].options).toMatchObject({
      resume: 'session-2',
      resumeSessionAt: 'uuid-1',
      forkSession: true
    })
    expect(activePath(ops.listMessagesByThread(db, threadId)).map((m) => m.content)).toEqual([
      '最初の指示',
      '1回目',
      '次の指示（修正）',
      '2回目（編集後）'
    ])
  })

  it('Cowork では添付ファイルを受け付けない', () => {
    expect(() => service.send({ threadId, content: 'x', attachmentIds: ['a'] })).toThrow('添付')
  })

  it('完了の通知を受けてすぐに Undo・次の指示ができる', async () => {
    let undoError: unknown = 'not called'
    setup([{ calls: [{ tool: 'Write', input: { file_path: 'n.txt', content: '1' } }] }])
    const original = service
    events = []
    const listen = (e: ChatEvent): void => {
      if (e.type === 'finished') {
        try {
          original.undo(e.message.id)
          undoError = null
        } catch (error) {
          undoError = error
        }
      }
    }
    const emit = (service as unknown as { deps: { emit: (e: ChatEvent) => void } }).deps
    const base = emit.emit
    emit.emit = (e) => {
      base(e)
      listen(e)
    }
    await send()
    expect(undoError).toBeNull()
    expect(existsSync(join(work, 'n.txt'))).toBe(false)
  })

  it('再開したセッションでも、その実行の分だけを使用量として記録する（累計を重複して数えない）', async () => {
    setup([{ text: '1' }, { text: '2' }])
    const first = await send('1回目')
    const second = await send('2回目')
    expect(fake.runs[1].options.resume).toBe('session-1')

    const rows = db
      .prepare(
        'SELECT message_id, input_tokens, output_tokens, estimated_cost FROM usage_records ORDER BY created_at, rowid'
      )
      .all() as { message_id: string; input_tokens: number; estimated_cost: number }[]
    expect(rows.map((r) => [r.message_id, r.input_tokens])).toEqual([
      [first, 1000],
      [second, 1000]
    ])
    expect(rows[1].estimated_cost).toBeCloseTo(0.0123, 6)
    expect(ops.getMessage(db, second)!.estimated_cost).toBeCloseTo(0.0123, 6)
  })

  it('編集して再実行（分岐）でも、その実行の分だけを記録する', async () => {
    setup([{ text: '1' }, { text: '2' }, { text: '2改' }])
    await send('1回目')
    await send('2回目')
    const path = activePath(ops.listMessagesByThread(db, threadId))
    service.editAndResend({
      userMessageId: path[2].id,
      content: '2回目（修正）',
      keepAttachmentIds: [],
      attachmentIds: []
    })
    await service.whenIdle(threadId)

    const rows = db
      .prepare('SELECT input_tokens FROM usage_records ORDER BY created_at, rowid')
      .all() as { input_tokens: number }[]
    expect(rows.map((r) => r.input_tokens)).toEqual([1000, 1000, 1000])
  })

  it('Web・スキル・MCP の設定を実行に渡し、サブエージェントの実行を記録する（6.6）', async () => {
    setCoworkSettings(db, projectId, { webAccess: true })
    mkdirSync(join(work, '.claude', 'skills', 'report'), { recursive: true })
    writeFileSync(
      join(work, '.claude', 'skills', 'report', 'SKILL.md'),
      ['---', 'name: report', '---', '手順'].join('\n')
    )
    setSkillsTrust(db, projectId, work, true)
    fake = fakeAgentSdk([
      { calls: [{ tool: 'Read', input: { file_path: 'a.txt' }, agentId: 'sub-1' }], text: 'ok' }
    ])
    service = new CoworkService({
      db,
      snapshotsDir: join(base, 'snapshots'),
      modelService: new ModelService(db, () => null),
      getApiKey: () => 'sk-test',
      configDir: join(base, 'agent'),
      loadSdk: fake.loadSdk,
      pluginsRoot: join(base, 'plugins'),
      mcp: {
        toSdkConfig: () => ({ github: { type: 'stdio', command: 'npx', args: [], env: {} } })
      },
      emit: (e) => events.push(e)
    })
    await send()

    const { options } = fake.runs[0]
    expect(options.tools).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch', 'Skill']))
    expect(options.disallowedTools).toEqual([])
    expect(options.plugins).toEqual([
      { type: 'local', path: join(base, 'plugins', projectId), skipMcpDiscovery: true }
    ])
    expect(options.skills).toEqual(['lumina-project:report'])
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(['github', 'lumina'])
    expect(service.listToolEvents(threadId)[0].agent_id).toBe('sub-1')
  })
})
