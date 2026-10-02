/**
 * スラッシュコマンドの展開（要件 6.6）
 * 本文の $ARGUMENTS を引数全体に、$1〜$9 を空白で区切った各引数に置き換える。
 */
export function expandCommand(content: string, args: string): string {
  const trimmed = args.trim()
  const parts = trimmed ? trimmed.split(/\s+/) : []
  return content
    .replace(/\$ARGUMENTS/g, trimmed)
    .replace(/\$([1-9])/g, (_, n: string) => parts[Number(n) - 1] ?? '')
}

/** 入力が「/名前 引数」の形なら分解する */
export function parseCommandInput(text: string): { name: string; args: string } | null {
  const match = text.match(/^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/)
  return match ? { name: match[1], args: match[2] ?? '' } : null
}
