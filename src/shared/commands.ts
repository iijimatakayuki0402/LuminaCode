/**
 * スラッシュコマンドの展開（要件 6.6）
 * 本文の $ARGUMENTS を引数全体に、$1〜$9 を空白で区切った各引数に置き換える。
 */
export function expandCommand(content: string, args: string): string {
  const trimmed = args.trim()
  const parts = trimmed ? trimmed.split(/\s+/) : []
  // 一度に置き換える（引数に含まれる $ が再び置き換えられないようにする）
  return content.replace(/\$(ARGUMENTS|[1-9])/g, (_, key: string) =>
    key === 'ARGUMENTS' ? trimmed : (parts[Number(key) - 1] ?? '')
  )
}

/** 入力が「/名前 引数」の形なら分解する */
export function parseCommandInput(text: string): { name: string; args: string } | null {
  const match = text.match(/^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/)
  return match ? { name: match[1], args: match[2] ?? '' } : null
}
