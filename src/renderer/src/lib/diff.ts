/**
 * 行単位の差分（SEC-15 の差分表示用）
 * 最長共通部分列で求める。大きなファイルは計算量が増えるため、行数で打ち切る。
 */

export type DiffLine = { type: 'same' | 'add' | 'remove'; text: string }

export const MAX_DIFF_LINES = 3000

export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null

  // 共通の先頭・末尾を除いてから計算する
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)

  const table: number[][] = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0)
  )
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i][j] =
        x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const middle: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push({ type: 'same', text: x[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      middle.push({ type: 'remove', text: x[i++] })
    } else {
      middle.push({ type: 'add', text: y[j++] })
    }
  }
  while (i < x.length) middle.push({ type: 'remove', text: x[i++] })
  while (j < y.length) middle.push({ type: 'add', text: y[j++] })

  return [
    ...a.slice(0, start).map((text) => ({ type: 'same' as const, text })),
    ...middle,
    ...a.slice(endA).map((text) => ({ type: 'same' as const, text }))
  ]
}
