// Vitest を Electron 同梱の Node（ELECTRON_RUN_AS_NODE）で実行する。
// ネイティブモジュール（better-sqlite3）が本番と同じ Electron ランタイムで読み込めることを確認するために使う。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron') // Node から読み込むと実行ファイルのパスが返る
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

const result = spawnSync(electron, [vitest, 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(result.status ?? 1)
