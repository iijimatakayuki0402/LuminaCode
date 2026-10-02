/**
 * Cowork の拡張（要件 6.6）
 *   - スラッシュコマンド: 作業フォルダの .claude\commands\*.md を入力欄の候補にする（展開した内容は送信前に確認できる）
 *   - スキル: 作業フォルダの .claude\skills を、信頼の確認を経てから有効にする。
 *     作業フォルダの設定ファイル（hooks・apiKeyHelper など、任意のコマンドを実行し得るもの）は読み込まず、
 *     スキルだけをアプリが用意したプラグインのフォルダにコピーして Agent SDK に渡す
 *   - Web アクセス: プロジェクトごとのオン／オフ（既定はオフ）
 */

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { CoworkProjectSettings, SkillInfo, SkillsStatus, SlashCommand } from '@shared/types'
import { deleteSetting, getSetting, setSetting } from '../db/operations'

const MAX_COMMAND_BYTES = 64 * 1024
const MAX_SKILLS_BYTES = 20 * 1024 * 1024
export const SKILL_PLUGIN_NAME = 'lumina-project'

/** Markdown の先頭の front matter から description を取り出す */
function frontMatter(text: string): {
  description: string | null
  name: string | null
  body: string
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { description: null, name: null, body: text }
  const field = (key: string): string | null => {
    const line = match[1].split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${key}:`))
    return line
      ? line
          .slice(key.length + 1)
          .trim()
          .replace(/^["']|["']$/g, '') || null
      : null
  }
  return {
    description: field('description'),
    name: field('name'),
    body: text.slice(match[0].length)
  }
}

function walk(dir: string, visit: (path: string) => void, depth = 0): void {
  if (depth > 4) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) continue // 作業フォルダの外を指すリンクはたどらない
    if (stat.isDirectory()) walk(full, visit, depth + 1)
    else visit(full)
  }
}

// ========================================
// スラッシュコマンド
// ========================================

export function listSlashCommands(workRoot: string): SlashCommand[] {
  const dir = join(workRoot, '.claude', 'commands')
  const commands: SlashCommand[] = []
  walk(dir, (file) => {
    if (!file.toLowerCase().endsWith('.md') || statSync(file).size > MAX_COMMAND_BYTES) return
    const { description, body } = frontMatter(readFileSync(file, 'utf-8'))
    const name = relative(dir, file).slice(0, -3).split(sep).join(':')
    commands.push({ name, description, content: body.trim() })
  })
  return commands.sort((a, b) => a.name.localeCompare(b.name))
}

export { expandCommand } from '@shared/commands'

// ========================================
// スキル
// ========================================

const skillsDir = (workRoot: string): string => join(workRoot, '.claude', 'skills')
const TRUST_KEY = (projectId: string): string => `cowork.skillsTrust.${projectId}`

export function listSkills(workRoot: string): SkillInfo[] {
  const dir = skillsDir(workRoot)
  if (!existsSync(dir)) return []
  const skills: SkillInfo[] = []
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'SKILL.md')
    try {
      if (lstatSync(join(dir, name)).isSymbolicLink() || !existsSync(file)) continue
      const meta = frontMatter(readFileSync(file, 'utf-8'))
      skills.push({ name: meta.name ?? name, description: meta.description })
    } catch {
      // 読めないものは使わない
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** スキルの内容全体のハッシュ（内容が変わったら信頼し直す） */
export function skillsHash(workRoot: string): string | null {
  const dir = skillsDir(workRoot)
  if (!existsSync(dir)) return null
  const hash = createHash('sha256')
  let total = 0
  const files: string[] = []
  walk(dir, (file) => files.push(file))
  for (const file of files.sort()) {
    const bytes = readFileSync(file)
    total += bytes.length
    if (total > MAX_SKILLS_BYTES) return null
    hash.update(relative(dir, file)).update('\0').update(bytes)
  }
  return files.length > 0 ? hash.digest('hex') : null
}

export function skillsStatus(
  db: Database.Database,
  projectId: string,
  workRoot: string
): SkillsStatus {
  const skills = listSkills(workRoot)
  const hash = skills.length > 0 ? skillsHash(workRoot) : null
  return { skills, trusted: hash !== null && getSetting(db, TRUST_KEY(projectId)) === hash }
}

export function setSkillsTrust(
  db: Database.Database,
  projectId: string,
  workRoot: string,
  trust: boolean
): SkillsStatus {
  const hash = skillsHash(workRoot)
  if (trust && hash) setSetting(db, TRUST_KEY(projectId), hash)
  else deleteSetting(db, TRUST_KEY(projectId))
  return skillsStatus(db, projectId, workRoot)
}

/**
 * 信頼済みのスキルだけを含むプラグインのフォルダを作る（実行ごとに作り直す）
 * 戻り値はプラグインのフォルダ。信頼していない・スキルが無い場合は null
 */
export function buildSkillPlugin(
  db: Database.Database,
  projectId: string,
  workRoot: string,
  pluginsRoot: string
): string | null {
  if (!skillsStatus(db, projectId, workRoot).trusted) return null
  const dir = join(pluginsRoot, projectId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      { name: SKILL_PLUGIN_NAME, version: '1.0.0', description: '作業フォルダのスキル' },
      null,
      2
    )
  )
  // リンクはたどらずにコピーする（作業フォルダの外の内容を持ち込まない）
  cpSync(skillsDir(workRoot), join(dir, 'skills'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !lstatSync(source).isSymbolicLink()
  })
  return dir
}

// ========================================
// プロジェクトごとの Cowork の設定
// ========================================

const WEB_KEY = (projectId: string): string => `cowork.web.${projectId}`

export function getCoworkSettings(db: Database.Database, projectId: string): CoworkProjectSettings {
  return { webAccess: getSetting(db, WEB_KEY(projectId)) === '1' }
}

export function setCoworkSettings(
  db: Database.Database,
  projectId: string,
  input: Partial<CoworkProjectSettings>
): CoworkProjectSettings {
  if (input.webAccess !== undefined) {
    if (input.webAccess) setSetting(db, WEB_KEY(projectId), '1')
    else deleteSetting(db, WEB_KEY(projectId))
  }
  return getCoworkSettings(db, projectId)
}
