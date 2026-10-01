// Phase 0 技術検証（Electron メインプロセス上）。実行: npx electron scripts/phase0-electron-check.cjs
// API キーは環境変数 LUMINA_TEST_API_KEY で渡す（ファイルには保存しない）。
const { app } = require('electron')
const { mkdtempSync, mkdirSync, realpathSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const key = process.env.LUMINA_TEST_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    ANTHROPIC_API_KEY: key,
    ...extra
  }
}

async function run(name, prompt, options, hooks = {}) {
  if (process.env.LUMINA_ONLY && !new RegExp(process.env.LUMINA_ONLY).test(name)) return
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumina-el-')))
  const work = join(root, 'work')
  mkdirSync(work)
  const used = []
  const t0 = Date.now()
  const out = {
    name,
    subtype: null,
    is_error: null,
    turns: null,
    cost: null,
    tools: used,
    exception: null
  }
  try {
    const q = query({
      prompt,
      options: {
        cwd: work,
        env: baseEnv({ CLAUDE_CONFIG_DIR: join(root, '.cc') }),
        model: MODEL,
        settingSources: [],
        permissionMode: 'default',
        canUseTool: async (tool, input) => {
          used.push(tool)
          return { behavior: 'allow', updatedInput: input }
        },
        ...options
      }
    })
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init')
        out.initTools = m.tools.filter((t) => ['Bash', 'PowerShell'].includes(t))
      if (m.type === 'assistant')
        for (const b of m.message.content)
          if (b.type === 'tool_use') (out.toolUse ||= []).push(b.name)
      if (hooks.onMessage) await hooks.onMessage(m, q)
      if (m.type === 'result') {
        out.subtype = m.subtype
        out.is_error = m.is_error
        out.turns = m.num_turns
        out.cost = m.total_cost_usd
        out.text = String(m.result ?? m.errors ?? '').slice(0, 200)
      }
    }
  } catch (e) {
    out.exception = String(e.message ?? e).slice(0, 200)
  }
  out.ms = Date.now() - t0
  out.fileCreated = existsSync(join(work, 'a.txt'))
  console.log(JSON.stringify(out))
}

app.whenReady().then(async () => {
  try {
    if (!key) throw new Error('LUMINA_TEST_API_KEY が未設定です')
    console.log(
      'electron',
      process.versions.electron,
      'node',
      process.versions.node,
      'abi',
      process.versions.modules
    )

    // A. better-sqlite3 を Electron 上で読み込む
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec("create table t(x text); insert into t values ('ok')")
    console.log('sqlite:', JSON.stringify(db.prepare('select x, sqlite_version() v from t').get()))

    // B. Electron 上で query() を実行（ファイル作成）
    await run('electron-query', 'a.txt というファイルを作成し、内容を hi にしてください。', {
      maxTurns: 6
    })
    // C. 予算上限
    await run('budget-limit', 'a.txt を作成し、内容を hi にしてください。', {
      maxBudgetUsd: 0.0001,
      maxTurns: 6
    })
    // D. ターン上限
    await run(
      'turn-limit',
      'a.txt を内容 hi で作成し、作成後に Read で読み返して内容を報告してください。質問はせず、すぐ実行してください。',
      {
        maxTurns: 1
      }
    )
    // E. 実行中の中断（最初の assistant メッセージで interrupt）
    let interrupted = false
    await run(
      'interrupt',
      '1 から 200 までの数字を 1 行ずつ、説明なしで出力してください。',
      { maxTurns: 3 },
      {
        onMessage: async (m, q) => {
          if (m.type === 'assistant' && !interrupted) {
            interrupted = true
            await q.interrupt()
          }
        }
      }
    )
    // F. Git / bash が見つからない環境（PATH を System32 のみに制限）
    const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    await run('no-git-path', 'シェルコマンドで echo hello を実行し、出力を報告してください。', {
      maxTurns: 4,
      env: baseEnv({
        PATH: sys + ';' + join(sys, 'WindowsPowerShell', 'v1.0'),
        CLAUDE_CONFIG_DIR: join(tmpdir(), 'lumina-el-nogit')
      })
    })
  } catch (e) {
    console.log('FATAL', String(e.stack ?? e).slice(0, 500))
  }
  app.quit()
})
