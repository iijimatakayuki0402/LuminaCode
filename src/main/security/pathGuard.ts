import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// 要件 SEC-01〜03: 作業フォルダ境界の判定。
// パスを絶対化し、存在する最も深い祖先の実体パス（シンボリックリンク／ジャンクション／8.3 短縮名を解決）に
// 存在しない残りの部分を連結してから、作業フォルダ配下かどうかを比較する。

function resolveReal(p: string): string {
  let current = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return rest.length > 0 ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      rest.push(basename(current))
      current = parent
    }
  }
}

const normalizeCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

export function isInsideWorkFolder(workRoot: string, target: string): boolean {
  if (target.includes('\0')) return false
  // デバイスパス（バックスラッシュ 2 つ + ? または . で始まるパス）と NTFS の代替データストリーム（file.txt:stream）は拒否する
  if (/^[\x5c/]{2}[?.][\x5c/]/.test(target)) return false
  if (
    process.platform === 'win32' &&
    /^(?:[A-Za-z]:)?[^:]*:/.test(target.replace(/^[A-Za-z]:/, ''))
  )
    return false

  const root = normalizeCase(resolveReal(workRoot))
  const real = normalizeCase(resolveReal(resolve(workRoot, target)))
  const rel = relative(root, real)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
