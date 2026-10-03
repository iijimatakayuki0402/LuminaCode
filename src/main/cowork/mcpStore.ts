/**
 * MCP サーバーの設定（要件 6.6: プロジェクト単位で設定する。追加時は信頼の確認を経る）
 * トークンなどを含むため、設定全体を OS の暗号化（safeStorage / DPAPI）で暗号化して保存する。
 * 画面にはキーの名前だけを返し、値は返さない。
 */

import type Database from 'better-sqlite3'
import type { McpServer, McpServerSummary } from '@shared/types'
import { deleteSetting, getSetting, setSetting, ValidationError } from '../db/operations'
import type { SecretCipher } from '../secrets/apiKeyStore'

const KEY = (projectId: string): string => `cowork.mcp.${projectId}`
/** アプリの削除ツール（lumina）と重ならない、ツール名に使える名前 */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function summarize(server: McpServer): McpServerSummary {
  return server.type === 'stdio'
    ? {
        name: server.name,
        type: 'stdio',
        command: server.command,
        args: server.args,
        envKeys: Object.keys(server.env)
      }
    : { name: server.name, type: 'http', url: server.url, headerKeys: Object.keys(server.headers) }
}

export function validateServer(server: McpServer): McpServer {
  if (!NAME.test(server.name) || server.name === 'lumina') {
    throw new ValidationError(
      '名前は英小文字・数字・ハイフン・アンダースコア（32 文字以内）で指定してください（lumina は使えません）。'
    )
  }
  if (server.type === 'stdio') {
    if (!server.command.trim()) throw new ValidationError('起動するコマンドを入力してください。')
  } else {
    let url: URL
    try {
      url = new URL(server.url)
    } catch {
      throw new ValidationError('URL の形式が正しくありません。')
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new ValidationError(
        'HTTP の MCP サーバーは https の URL（ローカルは http も可）を指定してください。'
      )
    }
  }
  return server
}

export class McpStore {
  constructor(
    private readonly db: Database.Database,
    private readonly cipher: SecretCipher
  ) {}

  /** 保存済みのサーバー（main 内でのみ使う。値を含む） */
  list(projectId: string): McpServer[] {
    try {
      return this.stored(projectId)
    } catch (error) {
      console.warn('[mcp] failed to decrypt settings:', (error as Error).name)
      return []
    }
  }

  /** 保存済みのサーバー。読めない場合は例外（変更時に、読めなかった設定を消してしまわないように） */
  private stored(projectId: string): McpServer[] {
    const raw = getSetting(this.db, KEY(projectId))
    if (!raw) return []
    return JSON.parse(this.cipher.decryptString(Buffer.from(raw, 'base64'))) as McpServer[]
  }

  private storedForUpdate(projectId: string): McpServer[] {
    try {
      return this.stored(projectId)
    } catch {
      throw new ValidationError('保存済みの MCP サーバーの設定を読み取れないため、変更できません。')
    }
  }

  summaries(projectId: string): McpServerSummary[] {
    return this.list(projectId).map(summarize)
  }

  private save(projectId: string, servers: McpServer[]): void {
    if (servers.length === 0) {
      deleteSetting(this.db, KEY(projectId))
      return
    }
    if (!this.cipher.isEncryptionAvailable()) {
      throw new ValidationError(
        'この環境では設定を暗号化して保存できないため、MCP サーバーを追加できません。'
      )
    }
    setSetting(
      this.db,
      KEY(projectId),
      this.cipher.encryptString(JSON.stringify(servers)).toString('base64')
    )
  }

  /** 追加・置き換え（画面で信頼の確認を経てから呼ぶ） */
  upsert(projectId: string, server: McpServer): McpServerSummary[] {
    const checked = validateServer(server)
    const servers = this.storedForUpdate(projectId).filter((s) => s.name !== checked.name)
    this.save(projectId, [...servers, checked])
    return this.summaries(projectId)
  }

  remove(projectId: string, name: string): McpServerSummary[] {
    this.save(
      projectId,
      this.storedForUpdate(projectId).filter((s) => s.name !== name)
    )
    return this.summaries(projectId)
  }

  /** Agent SDK に渡す形 */
  toSdkConfig(projectId: string): Record<string, unknown> {
    const config: Record<string, unknown> = {}
    for (const s of this.list(projectId)) {
      config[s.name] =
        s.type === 'stdio'
          ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
          : { type: 'http', url: s.url, headers: s.headers }
    }
    return config
  }
}
