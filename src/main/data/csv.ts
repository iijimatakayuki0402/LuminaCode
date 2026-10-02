/**
 * CSV の書き出し（操作ログ LOG-02、利用履歴 USG-06）
 * Excel で文字化けせずに開けるよう BOM を付け、改行は CRLF にする。
 */

/** 1 つのセルの値。日時（epoch ms）は ISO 形式にする */
export const csvCell = (value: unknown): string => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'number' && value > 1e12
        ? new Date(value).toISOString()
        : String(value)
  // 表計算ソフトで数式として解釈されないようにする
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Excel が UTF-8 と判定するための BOM */
const BOM = String.fromCharCode(0xfeff)
const CRLF = String.fromCharCode(13, 10)

export function toCsv(header: readonly string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','))
  return BOM + lines.join(CRLF) + CRLF
}
