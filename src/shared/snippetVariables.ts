/**
 * スニペットの変数（要件 CHT-15）
 * {{名前}} の形で書く。前後の空白は無視し、同じ名前は 1 つの変数として扱う。
 */

const PATTERN = /\{\{[ \t]*([^{}\r\n]+?)[ \t]*\}\}/g

/** 出てくる順に、重複を除いた変数名 */
export function snippetVariables(content: string): string[] {
  const names: string[] = []
  for (const match of content.matchAll(PATTERN)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** 変数を値で置き換える（値の無い変数は空にする。値に {{ }} が含まれても展開し直さない） */
export function fillSnippet(content: string, values: Record<string, string>): string {
  return content.replace(PATTERN, (_, name: string) => values[name] ?? '')
}
