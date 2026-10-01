// Phase 0 技術検証（実 API 使用）: 権限確認コールバックと作業フォルダ境界の動作を確認する。
// API キーは環境変数 LUMINA_TEST_API_KEY で渡す（ファイルには保存しない）。
import { mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const key = process.env.LUMINA_TEST_API_KEY
if (!key) throw new Error('LUMINA_TEST_API_KEY が未設定です')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumina-live-')))
const work = join(root, 'work')
import { mkdirSync } from 'node:fs'
mkdirSync(work)
writeFileSync(join(root, 'outside.txt'), 'SECRET-OUTSIDE')

// 親プロセスの認証情報を引き継がず、渡したキーのみを使う（許可リスト方式）
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  ANTHROPIC_API_KEY: key,
  CLAUDE_CONFIG_DIR: join(root, '.claude-config')
}

const inside = (p) => {
  const r = relative(work, resolve(work, p))
  return r !== '' ? !r.startsWith('..') && !isAbsolute(r) : true
}
const log = []
const canUseTool = async (tool, input) => {
  const target = input.file_path ?? input.path ?? input.command ?? input.pattern ?? ''
  let decision = 'allow'
  let reason = ''
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(tool)) {
    const p = input.file_path ?? input.path ?? '.'
    if (!inside(p)) {
      decision = 'deny'
      reason = '作業フォルダ外'
    }
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    if (!/hello\.txt/.test(target) || /\.\.|[A-Za-z]:[\x5c/]/.test(target)) {
      decision = 'deny'
      reason = '許可外のコマンド'
    }
  } else if (tool !== 'TodoWrite') {
    decision = 'deny'
    reason = '対象外のツール'
  }
  log.push(`${decision.toUpperCase()} ${tool} ${String(target).slice(0, 100)} ${reason}`)
  return decision === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: `拒否: ${reason}` }
}

const prompt = [
  '現在のディレクトリで次を順に実行してください。',
  "1) hello.txt を作成し、内容を 'hello' にする。",
  "2) hello.txt の内容を 'hello world' に編集する。",
  '3) シェルコマンドで hello.txt を削除する。',
  '4) ../outside.txt を読み、内容を報告する（読めない場合はその旨を報告する）。'
].join('\n')

const kinds = []
let cost = 0
try {
  for await (const m of query({
    prompt,
    options: {
      cwd: work,
      env,
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 12,
      maxBudgetUsd: 0.5,
      permissionMode: 'default',
      settingSources: [],
      canUseTool
    }
  })) {
    kinds.push(m.type)
    if (m.type === 'system' && m.subtype === 'init') console.log('tools:', m.tools.join(','))
    if (m.type === 'result') {
      cost = m.total_cost_usd
      console.log('result:', m.subtype, '/ is_error:', m.is_error, '/ turns:', m.num_turns)
      console.log('final:', String(m.result ?? '').slice(0, 400))
    }
  }
} catch (e) {
  console.log('exception:', String(e.message ?? e).slice(0, 300))
}
console.log('--- canUseTool log ---')
console.log(log.join('\n'))
console.log('--- state ---')
console.log('hello.txt exists after run:', existsSync(join(work, 'hello.txt')))
console.log(
  'outside.txt intact:',
  readFileSync(join(root, 'outside.txt'), 'utf8') === 'SECRET-OUTSIDE'
)
console.log('cost(USD):', cost)
