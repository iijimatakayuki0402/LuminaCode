/**
 * 会話の分岐から、現在の会話（根から末端までの一続き）を求める
 * 編集・再送信（CHT-14）や再生成では同じ親の下に新しい兄弟ができ、各階層で最も新しい子を辿る。
 * 古い版は分岐履歴として DB に残る。
 */

export interface ConversationNode {
  id: string
  parent_id: string | null
}

/**
 * @param nodes 作成順に並んだメッセージ
 */
export function activePath<T extends ConversationNode>(nodes: T[]): T[] {
  const children = new Map<string | null, T[]>()
  const ids = new Set(nodes.map((n) => n.id))
  for (const node of nodes) {
    // 親が削除済みのものは根として扱う
    const parent = node.parent_id !== null && ids.has(node.parent_id) ? node.parent_id : null
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }

  const path: T[] = []
  let current = children.get(null)?.at(-1)
  while (current) {
    path.push(current)
    current = children.get(current.id)?.at(-1)
  }
  return path
}
