export type MessageTone = 'info' | 'error'

export interface MessageState {
  tone: MessageTone
  text: string
}

/**
 * 結果・エラーの表示（スクリーンリーダーにも通知する）
 */
export function Message({ message }: { message: MessageState | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <p
      className={`message message-${message.tone}`}
      role={message.tone === 'error' ? 'alert' : 'status'}
    >
      {message.text}
    </p>
  )
}
