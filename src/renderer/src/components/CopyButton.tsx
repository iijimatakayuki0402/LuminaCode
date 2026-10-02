import { useEffect, useState } from 'react'
import { ja } from '../locales/ja'

/**
 * クリップボードへのコピー（CHT-05、CHT-10、CHT-13: 押すと「コピーしました」と短く表示する）
 */
export function CopyButton({
  text,
  label = ja.chat.copy,
  disabled = false,
  className = 'btn btn-sm'
}: {
  text: string
  label?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // クリップボードが使えない場合は何もしない
    }
  }

  return (
    <button className={className} type="button" onClick={() => void copy()} disabled={disabled}>
      <span aria-live="polite">{copied ? ja.chat.copied : label}</span>
    </button>
  )
}
