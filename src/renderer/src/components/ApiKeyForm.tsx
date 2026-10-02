import { useId, useState } from 'react'
import type { ApiKeyStatus } from '@shared/types'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'
import { Message, type MessageState } from './Message'

/**
 * API キーの入力と保存（要件 KEY-02: 疎通テストに成功した場合のみ保存する）
 * 保存に成功したら入力欄を空にする（失敗時は修正できるよう残す）。
 */
export function ApiKeyForm({
  onSaved
}: {
  onSaved: (status: ApiKeyStatus) => void
}): React.JSX.Element {
  const inputId = useId()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setMessage({ tone: 'info', text: ja.apiKey.testing })
    try {
      const status = await unwrap(window.lumina.apiKey.save(apiKey))
      setApiKey('')
      setMessage({ tone: 'info', text: ja.apiKey.saved })
      onSaved(status)
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor={inputId}>{ja.apiKey.label}</label>
        <input
          id={inputId}
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={ja.apiKey.placeholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={busy}
        />
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy || apiKey.trim() === ''}>
        {busy ? ja.apiKey.testing : ja.apiKey.saveAndTest}
      </button>
      <Message message={message} />
    </form>
  )
}
