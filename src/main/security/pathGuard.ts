import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// 要件 SEC-01〜03: 作業フォルダ境界の判定。
// パスを絶対化し、存在する最も深い祖先の実体パス（シンボリックリンク／ジャンクション／8.3 短縮名を解決）に
// 存在しない残りの部分を連結してから、作業フォルダ配下かどうかを比較する。

/** リンク先が存在しないシンボリックリンク／ジャンクションなら、リンク先を返す */
function danglingLinkTarget(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? resolve(dirname(p), readlinkSync(p)) : null
  } catch {
    return null
  }
}

/** 解決できない場合（リンクの循環など）は null */
function resolveReal(p: string): string | null {
  let current = resolve(p)
  const rest: string[] = []
  let hops = 0
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return rest.length > 0 ? join(real, ...rest.reverse()) : real
    } catch {
      // リンク先がまだ無いリンクは、書き込むとリンク先に作られるため、リンク先で判定する
      const target = danglingLinkTarget(current)
      if (target !== null) {
        if (++hops > 40) return null
        current = target
        continue
      }
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

  const rootReal = resolveReal(workRoot)
  const targetReal = resolveReal(resolve(workRoot, target))
  if (rootReal === null || targetReal === null) return false
  const rel = relative(normalizeCase(rootReal), normalizeCase(targetReal))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
