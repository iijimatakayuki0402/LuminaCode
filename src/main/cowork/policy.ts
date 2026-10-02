/**
 * Cowork のツール実行の判定（要件 6.7、9.1〜9.3）
 * Agent SDK の PreToolUse フックから、すべてのツール実行（サブエージェントを含む）について呼ばれる。
 * ここでの判定が最終判断となる（SDK の権限ルールやプロジェクトの設定では緩められない）。
 */

import { isAbsolute, resolve } from 'node:path'
import type { PermissionMode, ToolCategory } from '@shared/types'
import { isInsideWorkFolder } from '../security/pathGuard'

/** アプリが提供する削除ツール（.lumina-trash へ退避する。SEC-10） */
export const DELETE_TOOL = 'mcp__lumina__delete_files'

export interface Classified {
  category: ToolCategory
  /** 対象のパス（作業フォルダ基準の絶対パス） */
  paths: string[]
  command?: string
  /** 作業フォルダの外を指すパス（SEC-01〜03） */
  outside: string[]
  /** 読み取り専用のフォルダへの書き込み・削除（COW-12） */
  readOnly?: boolean
  /** 専用の確認が必要な理由（SEC-04: .git、.lumina-trash） */
  danger?: string
  /** 判定の対象外（未知のツール）なら理由 */
  unsupported?: string
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
// 実行の補助（ファイルやコマンドに触れない）
// Skill は信頼済みのスキルの読み込みのみ（スキルが行う操作はそれぞれのツールとして判定される）
const SAFE_TOOLS = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Agent',
  'Task',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Skill'
])
const PLAN_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode'])

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function protectedReason(workRoot: string, target: string): string | undefined {
  const parts = resolve(workRoot, target).toLowerCase().split(/[\\/]/)
  if (parts.includes('.git')) return '.git フォルダ（Git の履歴）'
  if (parts.includes('.lumina-trash')) return '.lumina-trash（アプリの退避先）'
  return undefined
}

/**
 * ツール呼び出しを分類し、対象のパスが作業フォルダ内かを確かめる
 */
export function classifyTool(
  toolName: string,
  input: unknown,
  workRoot: string,
  /** 読み取りだけを許すフォルダ（信頼済みのスキルのコピー、読み取り専用の追加フォルダ）。書き込み・削除には使わない */
  readRoots: string[] = [],
  /** 作業フォルダのほかに書き込み・削除できるフォルダ（読み書きの追加フォルダ。COW-12） */
  writeRoots: string[] = []
): Classified {
  const args = (input ?? {}) as Record<string, unknown>
  const check = (category: ToolCategory, rawPaths: (string | undefined)[]): Classified => {
    const paths = rawPaths.filter((p): p is string => !!p).map((p) => resolve(workRoot, p))
    const writable = [workRoot, ...writeRoots]
    const roots = category === 'read' ? [...writable, ...readRoots] : writable
    const outside = paths.filter((p) => !roots.some((root) => isInsideWorkFolder(root, p)))
    const readOnly =
      category !== 'read' &&
      outside.some((p) => readRoots.some((root) => isInsideWorkFolder(root, p)))
    const danger = paths.map((p) => protectedReason(workRoot, p)).find(Boolean)
    return {
      category,
      paths,
      outside,
      ...(readOnly ? { readOnly } : {}),
      ...(danger ? { danger } : {})
    }
  }

  if (READ_TOOLS.has(toolName)) {
    const pattern = str(args['pattern'])
    // Glob のパターンが絶対パスなら、その位置も検査する
    const patternPath = toolName === 'Glob' && pattern && isAbsolute(pattern) ? pattern : undefined
    const base = str(args['file_path']) ?? str(args['notebook_path']) ?? str(args['path']) ?? '.'
    return check('read', [base, patternPath])
  }
  if (toolName in WRITE_TOOLS) {
    return check('write', [str(args[WRITE_TOOLS[toolName]])])
  }
  if (toolName === DELETE_TOOL) {
    const paths = Array.isArray(args['paths']) ? args['paths'].map(str) : []
    return check('delete', paths)
  }
  if (COMMAND_TOOLS.has(toolName)) {
    return { category: 'command', paths: [], outside: [], command: str(args['command']) ?? '' }
  }
  if (SAFE_TOOLS.has(toolName)) return { category: 'other', paths: [], outside: [] }
  if (PLAN_TOOLS.has(toolName)) return { category: 'plan', paths: [], outside: [] }
  if (toolName === 'WebSearch' || toolName === 'WebFetch') {
    // 対象（URL・検索語）はコマンドの欄で示す
    const target = str(args['url']) ?? str(args['query']) ?? ''
    return { category: 'web', paths: [], outside: [], command: target }
  }
  // プロジェクトで設定した MCP サーバーのツール（6.6）
  if (toolName.startsWith('mcp__')) {
    return {
      category: 'mcp',
      paths: [],
      outside: [],
      command: JSON.stringify(input ?? {}).slice(0, 2000)
    }
  }
  return {
    category: 'other',
    paths: [],
    outside: [],
    unsupported: `このツールは Lumina Code では使えません: ${toolName}`
  }
}

// ========================================
// コマンドの拒否リスト・許可リスト（SEC-22、SEC-23）
// ========================================

/** 既定の拒否リスト（正規表現の文字列。大文字小文字を区別しない） */
export const DEFAULT_COMMAND_DENY_PATTERNS: string[] = [
  // ディスクのフォーマット・パーティション操作
  String.raw`\b(format|diskpart|mkfs|fdisk)\b`,
  String.raw`\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b`,
  // レジストリ・システム設定の変更
  String.raw`\breg(\.exe)?\s+(add|delete|import|load|restore)\b`,
  String.raw`\b(New|Set|Remove)-ItemProperty\b.*\bHK(LM|CU|CR|U|CC)\b`,
  String.raw`\b(bcdedit|bootrec|schtasks|sc(\.exe)?\s+(create|config|delete)|netsh|vssadmin)\b`,
  String.raw`\b(Set-ExecutionPolicy|Stop-Computer|Restart-Computer|shutdown)\b`,
  // ネットワーク越しのダウンロードと実行
  String.raw`\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|\s*(sh|bash|pwsh|powershell|iex|Invoke-Expression)\b`,
  String.raw`\b(iex|Invoke-Expression)\b.*\b(DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b`,
  // ルートの一括削除
  String.raw`\brm\s+(-[a-z]*\s+)*(/|~|[a-z]:[\\/]?)(\s|$)`
]

/** コマンドによる削除（SEC-10: 削除は退避ツールで行う） */
const DELETE_COMMAND = String.raw`(^|[\s;&|(])(rm|rmdir|del|erase|rd|Remove-Item|ri|unlink|shred)(\s|$)`

/** 作業フォルダ外の絶対パスを明示しているか（SEC-22） */
function referencesOutside(command: string, roots: string[]): string | undefined {
  const candidates = command.match(/(?:[A-Za-z]:[\\/][^\s"'`|;&<>]*|\\\\[^\s"'`|;&<>]+)/g) ?? []
  return candidates.find((p) => !roots.some((root) => isInsideWorkFolder(root, p)))
}

export interface CommandRules {
  denyPatterns: string[]
  /** 事前に許可するコマンド（完全一致、または末尾の * で前方一致） */
  allowCommands: string[]
}

export type CommandCheck =
  | { verdict: 'deny'; reason: string }
  | { verdict: 'delete' }
  | { verdict: 'allowlisted' }
  | { verdict: 'ask' }

export function checkCommand(
  command: string,
  workRoot: string,
  rules: CommandRules,
  /** パスの指定を認めるフォルダ（信頼済みのスキルのコピー。実行は確認を経る） */
  extraRoots: string[] = []
): CommandCheck {
  const text = command.trim()
  for (const pattern of rules.denyPatterns) {
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      continue
    }
    if (re.test(text)) return { verdict: 'deny', reason: '拒否リストに一致するコマンドです' }
  }
  const outside = referencesOutside(text, [workRoot, ...extraRoots])
  if (outside)
    return { verdict: 'deny', reason: `作業フォルダ外のパスを含むコマンドです: ${outside}` }
  if (new RegExp(DELETE_COMMAND, 'i').test(text)) return { verdict: 'delete' }
  const allowed = rules.allowCommands.some((rule) =>
    rule.endsWith('*') ? text.startsWith(rule.slice(0, -1)) : text === rule
  )
  return allowed ? { verdict: 'allowlisted' } : { verdict: 'ask' }
}

// ========================================
// 判定（6.7）
// ========================================

export type Scope = 'thread' | 'project'

export interface AlwaysAllow {
  thread: ToolCategory[]
  project: ToolCategory[]
}

export type Decision =
  | {
      action: 'allow'
      method: 'auto' | 'allowed_always_thread' | 'allowed_always_project'
    }
  | { action: 'ask'; reason?: string; offerAlways: boolean }
  | { action: 'deny'; reason: string }

/** 「常に許可」が設定されていても確認する件数（SEC-13） */
export const BULK_DELETE_THRESHOLD = 10

export interface DecideContext {
  mode: PermissionMode
  always: AlwaysAllow
  commandRules: CommandRules
  workRoot: string
  /** 削除対象にフォルダを含むか（SEC-13） */
  includesFolder?: boolean
  /** Web 検索・Web 取得を使えるか（6.6: 既定はオフ） */
  webAccess?: boolean
  /** コマンドでのパスの指定を認めるフォルダ（信頼済みのスキルのコピー、読み書きの追加フォルダ） */
  extraRoots?: string[]
}

export function decide(c: Classified, ctx: DecideContext): Decision {
  if (c.unsupported) return { action: 'deny', reason: c.unsupported }
  if (c.category === 'web' && !ctx.webAccess) {
    return {
      action: 'deny',
      reason: 'Web へのアクセスは無効です（プロジェクトの設定でオンにできます）。'
    }
  }
  if (c.readOnly) {
    return {
      action: 'deny',
      reason: `読み取り専用のフォルダには書き込み・削除できません: ${c.outside[0]}`
    }
  }
  if (c.outside.length > 0) {
    return { action: 'deny', reason: `作業フォルダの外へのアクセスは拒否しました: ${c.outside[0]}` }
  }
  if (c.category === 'read' || c.category === 'other') return { action: 'allow', method: 'auto' }
  // Web・MCP は外部とやり取りするため、どのモードでも確認する（計画のみでも調べものには使える）
  if (c.category === 'web' || c.category === 'mcp') {
    if (ctx.mode === 'plan_only' && c.category === 'mcp') {
      return { action: 'deny', reason: '計画のみモードのため、MCP のツールは使えません。' }
    }
    const scope = ctx.always.thread.includes(c.category)
      ? 'allowed_always_thread'
      : ctx.always.project.includes(c.category)
        ? 'allowed_always_project'
        : null
    return scope ? { action: 'allow', method: scope } : { action: 'ask', offerAlways: true }
  }

  // 計画のみ: 変更は一切行わない。計画の提示（ExitPlanMode）は、本文での提示に切り替えさせる
  if (ctx.mode === 'plan_only') {
    return c.category === 'plan'
      ? {
          action: 'deny',
          reason: '計画のみモードです。計画は本文で提示し、実行はしないでください。'
        }
      : { action: 'deny', reason: '計画のみモードのため、変更やコマンドの実行は行えません。' }
  }
  if (c.category === 'plan') return { action: 'allow', method: 'auto' }

  const category = c.category
  if (category === 'command') {
    const result = checkCommand(c.command ?? '', ctx.workRoot, ctx.commandRules, ctx.extraRoots)
    if (result.verdict === 'deny') return { action: 'deny', reason: result.reason }
    if (result.verdict === 'delete') {
      return {
        action: 'deny',
        reason: `ファイルの削除にコマンドは使えません。${DELETE_TOOL} ツールを使ってください（削除したファイルは .lumina-trash に退避されます）。`
      }
    }
    if (result.verdict === 'allowlisted') return { action: 'allow', method: 'auto' }
  }

  // SEC-04: .git・.lumina-trash は常に専用の確認
  if (c.danger) return { action: 'ask', reason: c.danger, offerAlways: false }

  const always = (scope: Scope): boolean => ctx.always[scope].includes(category)
  const alwaysMethod = always('thread')
    ? 'allowed_always_thread'
    : always('project')
      ? 'allowed_always_project'
      : null

  if (category === 'delete') {
    // 削除はどのモードでも自動許可しない。常に許可でも、多数・フォルダの削除は確認する（SEC-13）
    const bulk = c.paths.length >= BULK_DELETE_THRESHOLD || !!ctx.includesFolder
    if (alwaysMethod && !bulk) return { action: 'allow', method: alwaysMethod }
    return { action: 'ask', offerAlways: !bulk }
  }
  if (alwaysMethod) return { action: 'allow', method: alwaysMethod }
  if (category === 'write' && ctx.mode === 'auto_edit') return { action: 'allow', method: 'auto' }
  return { action: 'ask', offerAlways: true }
}
