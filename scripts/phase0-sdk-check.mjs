// Phase 0 技術検証: Agent SDK が Windows で起動できるかを確認する（API キーは使わない）。
// ダミーのキーで query() を実行し、同梱の claude.exe が起動して認証エラーを返すところまでを確認する。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

const cwd = mkdtempSync(join(tmpdir(), 'lumina-phase0-'))
const env = {
  ...process.env,
  ANTHROPIC_API_KEY: 'sk-ant-dummy-for-startup-check',
  CLAUDE_CONFIG_DIR: join(cwd, '.claude-config')
}
// 親プロセスの認証情報（Bedrock／Vertex／AWS／既存の Anthropic 設定）が使われて課金されないよう、すべて除外する
for (const k of Object.keys(env)) {
  if (/^(AWS_|ANTHROPIC_(?!API_KEY$)|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH)/.test(k)) delete env[k]
}

const kinds = []
try {
  for await (const m of query({
    prompt: 'ping',
    options: { cwd, env, maxTurns: 1, permissionMode: 'plan' }
  })) {
    kinds.push(m.type + (m.subtype ? ':' + m.subtype : ''))
    if (m.type === 'system' && m.subtype === 'init') {
      console.log('init: tools =', (m.tools ?? []).join(','))
      console.log(
        'init: model =',
        m.model,
        '/ permissionMode =',
        m.permissionMode,
        '/ cwd =',
        m.cwd
      )
    }
    if (m.type === 'result')
      console.log(
        'result:',
        JSON.stringify({ is_error: m.is_error, result: String(m.result ?? '').slice(0, 160) })
      )
  }
} catch (e) {
  console.log('exception:', String(e.message ?? e).slice(0, 300))
}
console.log('messages:', kinds.join(' -> '))
