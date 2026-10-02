// アプリに同梱する依存パッケージのライセンス一覧を作る（要件 6.12 のライセンス表示）
// package-lock.json の本番依存（dev 以外）と Electron 本体を対象に、resources/licenses.json へ書き出す。
// 使い方: node scripts/generate-licenses.mjs（npm run build・dist で自動実行）

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf-8'))
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i
// 1 件あたりのライセンス文の上限（極端に大きいファイルで一覧が重くならないように）
const MAX_TEXT = 64 * 1024

function licenseText(dir) {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
  if (files.length === 0) return null
  return files
    .map((f) => readFileSync(join(dir, f), 'utf-8').trim())
    .join('\n\n')
    .slice(0, MAX_TEXT)
}

function licenseName(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

const seen = new Set()
const packages = []
const add = (path) => {
  const dir = join(root, path)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return
  const pkg = JSON.parse(readFileSync(manifest, 'utf-8'))
  const id = `${pkg.name}@${pkg.version}`
  if (seen.has(id)) return
  seen.add(id)
  packages.push({
    name: pkg.name,
    version: pkg.version,
    license: licenseName(pkg),
    text: licenseText(dir)
  })
}

for (const [path, info] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || info.dev || info.devOptional) continue
  add(path)
}
// Electron 本体は devDependencies だが、アプリに同梱される（Chromium のライセンスはインストール先の LICENSES.chromium.html）
add('node_modules/electron')

packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const out = join(root, 'resources', 'licenses.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ appLicense: app.license ?? null, packages }) + '\n', 'utf-8')
console.log(`licenses: ${packages.length} packages -> ${out}`)
