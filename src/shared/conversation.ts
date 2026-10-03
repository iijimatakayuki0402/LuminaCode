/**
 * 会話の分岐から、現在の会話（根から末端までの一続き）を求める
 * 編集・再送信（CHT-14）や再生成では同じ親の下に新しい兄弟ができる。古い版は分岐履歴として DB に残る。
 * 表示する分岐は「末端」で指定でき（CHT-06）、指定が無ければ各階層で最も新しい子を辿る。
 */

export interface ConversationNode {
  id: string
  parent_id: string | null
}

interface Tree<T> {
  byId: Map<string, T>
  /** 親 ID（根は null）→ 作成順の子 */
  children: Map<string | null, T[]>
}

function buildTree<T extends ConversationNode>(nodes: T[]): Tree<T> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map<string | null, T[]>()
  for (const node of nodes) {
    // 親が削除済みのものは根として扱う
    const parent = node.parent_id !== null && byId.has(node.parent_id) ? node.parent_id : null
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }
  return { byId, children }
}

/** 指定した位置の子孫を、各階層で最も新しい子を辿って返す */
function descend<T extends ConversationNode>(tree: Tree<T>, fromId: string | null): T[] {
  const result: T[] = []
  const seen = new Set<string>()
  let current = tree.children.get(fromId)?.at(-1)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    result.push(current)
    current = tree.children.get(current.id)?.at(-1)
  }
  return result
}

/**
 * @param nodes 作成順に並んだメッセージ
 * @param leafId 表示中の分岐の末端（CHT-06）。そこから根まで辿り、その先に新しい子があれば続けて辿る
 */
export function activePath<T extends ConversationNode>(nodes: T[], leafId?: string | null): T[] {
  const tree = buildTree(nodes)
  const leaf = leafId ? tree.byId.get(leafId) : undefined
  if (!leaf) return descend(tree, null)

  const upward: T[] = []
  const seen = new Set<string>()
  let current: T | undefined = leaf
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    upward.unshift(current)
    current = current.parent_id ? tree.byId.get(current.parent_id) : undefined
  }
  return [...upward, ...descend(tree, leaf.id)]
}

/**
 * 同じ親を持つ兄弟（分岐の候補）と、その中での位置（CHT-06 の「2/3」表示用）
 */
export function siblingsOf<T extends ConversationNode>(
  nodes: T[],
  node: T
): { siblings: T[]; index: number } {
  const tree = buildTree(nodes)
  const parent = node.parent_id !== null && tree.byId.has(node.parent_id) ? node.parent_id : null
  const siblings = tree.children.get(parent) ?? [node]
  return { siblings, index: siblings.findIndex((n) => n.id === node.id) }
}

/** 指定したメッセージから、最も新しい子を辿った末端 */
export function leafFrom<T extends ConversationNode>(nodes: T[], fromId: string): string {
  return descend(buildTree(nodes), fromId).at(-1)?.id ?? fromId
}

/** 根から指定したメッセージまで（その先の子孫は含めない） */
export function pathTo<T extends ConversationNode>(nodes: T[], id: string): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const result: T[] = []
  const seen = new Set<string>()
  let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    result.unshift(current)
    current = current.parent_id ? byId.get(current.parent_id) : undefined
  }
  return result
}
