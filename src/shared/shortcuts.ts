/**
 * キーボードショートカット（要件 CMN-02）
 * 送信キー（Enter／Ctrl+Enter）は入力欄で扱い、設定で切り替える（CHT-09）。
 */

export type ShortcutAction = 'newThread' | 'newProject' | 'search' | 'settings' | 'stop'

/** 判定に使うキー入力（KeyboardEvent の一部） */
export interface KeyInput {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing?: boolean
}

/** 画面に表示する一覧（設定画面）。順番もこの通りに表示する */
export const SHORTCUTS: { action: ShortcutAction; keys: string }[] = [
  { action: 'newThread', keys: 'Ctrl+N' },
  { action: 'newProject', keys: 'Ctrl+Shift+N' },
  { action: 'search', keys: 'Ctrl+K' },
  { action: 'settings', keys: 'Ctrl+,' },
  { action: 'stop', keys: 'Esc' }
]

/**
 * キー入力に対応する操作を返す（該当しなければ null）
 */
export function shortcutFor(e: KeyInput): ShortcutAction | null {
  // 日本語入力の変換中（Esc で変換を取り消す場合など）は扱わない
  if (e.isComposing || e.altKey || e.metaKey) return null
  const key = e.key.toLowerCase()
  if (!e.ctrlKey) return key === 'escape' && !e.shiftKey ? 'stop' : null
  if (key === 'n') return e.shiftKey ? 'newProject' : 'newThread'
  if (e.shiftKey) return null
  if (key === 'k') return 'search'
  if (key === ',') return 'settings'
  return null
}
