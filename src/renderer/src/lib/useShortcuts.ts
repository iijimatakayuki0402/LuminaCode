import { useEffect, useRef } from 'react'
import { shortcutFor, type ShortcutAction } from '@shared/shortcuts'

/**
 * キーボードショートカットを受け取る（要件 CMN-02）
 * モーダルダイアログの表示中は扱わない（Esc はダイアログを閉じる操作として使う）。
 */
export function useShortcuts(handlers: Partial<Record<ShortcutAction, () => void>>): void {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const action = shortcutFor(e)
      const handler = action ? ref.current[action] : undefined
      if (!handler || document.querySelector('dialog[open]')) return
      e.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
