import type Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, Message, PermissionRequest } from '../../src/shared/types'
import {
  buildSkillPlugin,
  expandCommand,
  getCoworkSettings,
  listSlashCommands,
  setCoworkSettings,
  setSkillsTrust,
  skillsStatus
} from '../../src/main/cowork/extensions'
import { listDir, readPreview } from '../../src/main/cowork/files'
import { McpStore } from '../../src/main/cowork/mcpStore'
import { classifyTool, decide, DEFAULT_COMMAND_DENY_PATTERNS } from '../../src/main/cowork/policy'
import { createInMemoryDatabase } from '../../src/main/db/init'
import * as ops from '../../src/main/db/operations'
import { notificationFor } from '../../src/main/notify'
import type { SecretCipher } from '../../src/main/secrets/apiKeyStore'

let db: Database.Database
let base: string
let work: string
let projectId: string

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`E:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(2), 'base64').toString()
}

beforeEach(() => {
  db = createInMemoryDatabase()
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'lumina-ext-')))
  work = join(base, 'work')
  mkdirSync(join(work, 'src'), { recursive: true })
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(base, 'outside', 'secret.txt'), 'secret')
  projectId = ops.createProject(db, { type: 'cowork', name: 'C', work_folder: work }).id
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  rmSync(base, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('ファイルツリーとプレビュー（COW-08）', () => {
  it('フォルダを先に名前順で並べ、リンクはたどらない', () => {
    writeFileSync(join(work, 'b.txt'), 'B')
    writeFileSync(join(work, 'a.md'), 'A')
    symlinkSync(join(base, 'outside'), join(work, 'link'), 'junction')
    const entries = listDir(work, '')
    expect(entries.map((e) => [e.name, e.isDir, e.isLink])).toEqual([
      ['src', true, false],
      ['a.md', false, false],
      ['b.txt', false, false],
      ['link', false, true]
    ])
  })

  it('作業フォルダの外は一覧もプレビューもできない', () => {
    symlinkSync(join(base, 'outside'), join(work, 'link'), 'junction')
    expect(() => listDir(work, '..')).toThrow('作業フォルダの外')
    expect(() => readPreview(work, '../outside/secret.txt')).toThrow('作業フォルダの外')
    expect(() => readPreview(work, 'link/secret.txt')).toThrow('作業フォルダの外')
  })

  it('テキスト・画像・バイナリのプレビュー', () => {
    writeFileSync(join(work, 'note.md'), '# メモ')
    writeFileSync(join(work, 'p.png'), Buffer.from([0x89, 0x50]))
    writeFileSync(join(work, 'x.bin'), Buffer.from([1, 0, 2]))
    writeFileSync(join(work, 'big.txt'), 'a'.repeat(300 * 1024))
    expect(readPreview(work, 'note.md')).toMatchObject({
      kind: 'text',
      text: '# メモ',
      truncated: false
    })
    expect(readPreview(work, 'p.png').dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(readPreview(work, 'x.bin').kind).toBe('unsupported')
    expect(readPreview(work, 'big.txt')).toMatchObject({ kind: 'text', truncated: true })
  })
})

describe('スラッシュコマンド（6.6）', () => {
  it('.claude\\commands の Markdown を候補にし、引数を当てはめる', () => {
    mkdirSync(join(work, '.claude', 'commands', 'git'), { recursive: true })
    writeFileSync(
      join(work, '.claude', 'commands', 'review.md'),
      '---\ndescription: コードを確認する\n---\n$ARGUMENTS を確認してください。'
    )
    writeFileSync(join(work, '.claude', 'commands', 'git', 'log.md'), '直近 $1 件の履歴')
    const commands = listSlashCommands(work)
    expect(commands.map((c) => [c.name, c.description])).toEqual([
      ['git:log', null],
      ['review', 'コードを確認する']
    ])
    expect(expandCommand(commands[1].content, 'src/a.ts')).toBe('src/a.ts を確認してください。')
    expect(expandCommand(commands[0].content, '5')).toBe('直近 5 件の履歴')
    expect(listSlashCommands(join(base, 'none'))).toEqual([])
  })
})

describe('スキル（6.6: 信頼の確認を経て有効にする）', () => {
  const addSkill = (
    name: string,
    body = '---\nname: ' + name + '\ndescription: 説明\n---\n手順'
  ): void => {
    mkdirSync(join(work, '.claude', 'skills', name), { recursive: true })
    writeFileSync(join(work, '.claude', 'skills', name, 'SKILL.md'), body)
  }

  it('信頼するまでは使わず、内容が変わったら信頼し直す', () => {
    addSkill('report')
    const plugins = join(base, 'plugins')
    expect(skillsStatus(db, projectId, work)).toEqual({
      skills: [{ name: 'report', description: '説明' }],
      trusted: false
    })
    expect(buildSkillPlugin(db, projectId, work, plugins)).toBeNull()

    expect(setSkillsTrust(db, projectId, work, true).trusted).toBe(true)
    const dir = buildSkillPlugin(db, projectId, work, plugins)!
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')).name).toBe(
      'lumina-project'
    )
    expect(existsSync(join(dir, 'skills', 'report', 'SKILL.md'))).toBe(true)

    writeFileSync(join(work, '.claude', 'skills', 'report', 'SKILL.md'), '書き換えられた手順')
    expect(skillsStatus(db, projectId, work).trusted).toBe(false)
    expect(buildSkillPlugin(db, projectId, work, plugins)).toBeNull()
  })

  it('作業フォルダの設定ファイル（hooks など）はプラグインに持ち込まない', () => {
    addSkill('report')
    writeFileSync(join(work, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[]}}')
    setSkillsTrust(db, projectId, work, true)
    const dir = buildSkillPlugin(db, projectId, work, join(base, 'plugins'))!
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
    expect(existsSync(join(dir, 'hooks'))).toBe(false)
  })
})

describe('MCP サーバー（6.6）', () => {
  it('暗号化して保存し、画面には値を返さない', () => {
    const store = new McpStore(db, cipher)
    const list = store.upsert(projectId, {
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret' }
    })
    expect(list).toEqual([
      {
        name: 'github',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server-github'],
        envKeys: ['GITHUB_TOKEN']
      }
    ])
    expect(JSON.stringify(list)).not.toContain('ghp_secret')
    expect(ops.getSetting(db, `cowork.mcp.${projectId}`)).not.toContain('ghp_secret')
    expect(store.toSdkConfig(projectId)).toEqual({
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server-github'],
        env: { GITHUB_TOKEN: 'ghp_secret' }
      }
    })
    expect(store.remove(projectId, 'github')).toEqual([])
  })

  it('名前・URL を検証する', () => {
    const store = new McpStore(db, cipher)
    expect(() =>
      store.upsert(projectId, { name: 'lumina', type: 'http', url: 'https://x', headers: {} })
    ).toThrow()
    expect(() =>
      store.upsert(projectId, { name: 'Bad Name', type: 'http', url: 'https://x', headers: {} })
    ).toThrow()
    expect(() =>
      store.upsert(projectId, { name: 'web', type: 'http', url: 'http://example.com', headers: {} })
    ).toThrow('https')
    expect(
      store.upsert(projectId, {
        name: 'local',
        type: 'http',
        url: 'http://localhost:3000/mcp',
        headers: {}
      })
    ).toHaveLength(1)
  })
})

describe('Web・MCP の判定（6.6）', () => {
  const ctx = (extra = {}) => ({
    mode: 'confirm_each' as const,
    always: { thread: [], project: [] },
    commandRules: { denyPatterns: DEFAULT_COMMAND_DENY_PATTERNS, allowCommands: [] },
    workRoot: work,
    ...extra
  })

  it('Web は設定でオンにしたときだけ、毎回確認して使える', () => {
    const c = classifyTool('WebFetch', { url: 'https://example.com', prompt: '要約' }, work)
    expect(c).toMatchObject({ category: 'web', command: 'https://example.com' })
    expect(decide(c, ctx())).toMatchObject({ action: 'deny' })
    expect(decide(c, ctx({ webAccess: true }))).toEqual({ action: 'ask', offerAlways: true })
    expect(decide(c, ctx({ webAccess: true, mode: 'auto_edit' }))).toMatchObject({ action: 'ask' })
    expect(decide(c, ctx({ webAccess: true, always: { thread: ['web'], project: [] } }))).toEqual({
      action: 'allow',
      method: 'allowed_always_thread'
    })
  })

  it('MCP のツールは確認する。計画のみでは使えない', () => {
    const c = classifyTool('mcp__github__create_issue', { title: 'x' }, work)
    expect(c.category).toBe('mcp')
    expect(decide(c, ctx({ mode: 'auto_edit' }))).toEqual({ action: 'ask', offerAlways: true })
    expect(decide(c, ctx({ mode: 'plan_only' }))).toMatchObject({ action: 'deny' })
  })

  it('プロジェクトごとの Web の設定', () => {
    expect(getCoworkSettings(db, projectId)).toEqual({ webAccess: false, gitSnapshots: false })
    expect(setCoworkSettings(db, projectId, { webAccess: true })).toEqual({
      webAccess: true,
      gitSnapshots: false
    })
  })
})

describe('トースト通知（COW-07）', () => {
  const lookup = (): { projectName: string; threadTitle: string; projectType: 'cowork' } => ({
    projectName: '整理',
    threadTitle: '議事録',
    projectType: 'cowork'
  })
  const finished = (status: Message['status']): ChatEvent =>
    ({
      type: 'finished',
      threadId: 't',
      message: { status } as Message,
      errorMessage: null
    }) as ChatEvent

  it('完了・エラー・確認待ちを、内容を含めずに通知する', () => {
    expect(notificationFor(finished('complete'), lookup)).toEqual({
      title: '作業が完了しました',
      body: '整理／議事録'
    })
    expect(notificationFor(finished('error'), lookup)?.title).toContain('エラー')
    expect(notificationFor(finished('stopped'), lookup)).toBeNull()
    const permission: ChatEvent = {
      type: 'permission',
      threadId: 't',
      request: { category: 'delete' } as PermissionRequest
    }
    expect(notificationFor(permission, lookup)?.body).toContain('ファイルの削除')
    expect(
      notificationFor({ type: 'text', threadId: 't', messageId: 'm', text: 'x' }, lookup)
    ).toBeNull()
  })

  it('タイトルが無い（最初の発言から作ったタイトルを含む）場合はプロジェクト名だけを出す', () => {
    expect(
      notificationFor(finished('complete'), () => ({
        projectName: '整理',
        threadTitle: null,
        projectType: 'cowork'
      }))
    ).toEqual({ title: '作業が完了しました', body: '整理' })
  })

  it('通常チャットは通知しない', () => {
    expect(
      notificationFor(finished('complete'), () => ({
        projectName: 'P',
        threadTitle: null,
        projectType: 'chat'
      }))
    ).toBeNull()
  })
})

describe('信頼済みのスキルのコピー（読み取りのみ許す）', () => {
  it('読み取りは許し、書き込み・削除は拒否し、コマンドでの指定は確認に回す', () => {
    const plugin = join(base, 'plugins', projectId)
    mkdirSync(join(plugin, 'skills', 'report'), { recursive: true })
    const ctx = {
      mode: 'auto_edit' as const,
      always: { thread: [], project: [] },
      commandRules: { denyPatterns: DEFAULT_COMMAND_DENY_PATTERNS, allowCommands: [] },
      workRoot: work,
      extraRoots: [plugin]
    }
    const file = join(plugin, 'skills', 'report', 'SKILL.md')
    expect(decide(classifyTool('Read', { file_path: file }, work, [plugin]), ctx)).toEqual({
      action: 'allow',
      method: 'auto'
    })
    expect(
      decide(classifyTool('Write', { file_path: file, content: 'x' }, work, [plugin]), ctx)
    ).toMatchObject({
      action: 'deny'
    })
    expect(
      decide(classifyTool('Bash', { command: `ls "${plugin}"` }, work, [plugin]), ctx)
    ).toEqual({
      action: 'ask',
      offerAlways: true
    })
    // スキルが無い実行では従来どおり拒否する
    expect(
      decide(classifyTool('Read', { file_path: file }, work), { ...ctx, extraRoots: [] })
    ).toMatchObject({
      action: 'deny'
    })
  })
})
