import { useEffect, useId, useState } from 'react'
import type { ApiKeyStatus, ModelList } from '@shared/types'
import { ApiKeyForm } from '../components/ApiKeyForm'
import { Message, type MessageState } from '../components/Message'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

/**
 * 設定画面（要件 6.12 のうち API・モデル）
 */
export function SettingsScreen({
  status,
  onStatusChange
}: {
  status: ApiKeyStatus
  onStatusChange: (status: ApiKeyStatus) => void
}): React.JSX.Element {
  return (
    <main className="screen">
      <h1 className="screen-title">SETTINGS</h1>
      <ApiKeySection status={status} onStatusChange={onStatusChange} />
      <ModelSection configured={status.configured} />
    </main>
  )
}

function ApiKeySection({
  status,
  onStatusChange
}: {
  status: ApiKeyStatus
  onStatusChange: (status: ApiKeyStatus) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage({ tone: 'info', text: await action() })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const test = (): Promise<void> =>
    run(async () => {
      await unwrap(window.lumina.apiKey.test())
      return ja.apiKey.testOk
    })

  const remove = (): Promise<void> => {
    if (!window.confirm(ja.apiKey.deleteConfirm)) return Promise.resolve()
    return run(async () => {
      onStatusChange(await unwrap(window.lumina.apiKey.delete()))
      return ja.apiKey.deleted
    })
  }

  return (
    <section className="panel" aria-labelledby="settings-api">
      <h2 id="settings-api">{ja.apiKey.section}</h2>
      {!status.encryptionAvailable && (
        <p className="message message-error" role="alert">
          {ja.apiKey.encryptionUnavailable}
        </p>
      )}
      <p>
        {ja.apiKey.current}:{' '}
        <span className="mono">{status.masked ?? ja.apiKey.notConfigured}</span>
      </p>
      {status.configured && !editing && (
        <div className="row">
          <button className="btn" type="button" onClick={() => void test()} disabled={busy}>
            {ja.apiKey.test}
          </button>
          <button className="btn" type="button" onClick={() => setEditing(true)} disabled={busy}>
            {ja.apiKey.change}
          </button>
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => void remove()}
            disabled={busy}
          >
            {ja.apiKey.delete}
          </button>
        </div>
      )}
      {(editing || !status.configured) && status.encryptionAvailable && (
        <>
          <ApiKeyForm
            onSaved={(next) => {
              setEditing(false)
              onStatusChange(next)
              setMessage({ tone: 'info', text: ja.apiKey.saved })
            }}
          />
          {editing && (
            <button className="btn btn-link" type="button" onClick={() => setEditing(false)}>
              {ja.common.cancel}
            </button>
          )}
        </>
      )}
      <Message message={message} />
    </section>
  )
}

function ModelSection({ configured }: { configured: boolean }): React.JSX.Element {
  const selectId = useId()
  const [list, setList] = useState<ModelList | null>(null)
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)

  const fetchModels = (refresh: boolean): Promise<[ModelList, string | null]> =>
    Promise.all([
      unwrap(window.lumina.models.list(refresh)),
      unwrap(window.lumina.models.getDefault())
    ])

  // API キーの登録・削除に合わせて読み直す
  useEffect(() => {
    let active = true
    fetchModels(false)
      .then(([next, current]) => {
        if (!active) return
        setList(next)
        setDefaultModel(current)
      })
      .catch((error: unknown) => {
        if (active) setMessage({ tone: 'error', text: (error as Error).message })
      })
    return () => {
      active = false
    }
  }, [configured])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const [next, current] = await fetchModels(true)
      setList(next)
      setDefaultModel(current)
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const change = async (modelId: string): Promise<void> => {
    try {
      await unwrap(window.lumina.models.setDefault(modelId))
      setDefaultModel(modelId)
      setMessage({ tone: 'info', text: ja.models.saved })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  const models = list?.models ?? []

  return (
    <section className="panel" aria-labelledby="settings-models">
      <h2 id="settings-models">{ja.models.section}</h2>
      {!configured && <p className="muted">{ja.models.needKey}</p>}
      {list?.stale && configured && <p className="message message-info">{ja.models.stale}</p>}
      <div className="field">
        <label htmlFor={selectId}>{ja.models.defaultModel}</label>
        <select
          id={selectId}
          className="select mono"
          value={defaultModel ?? ''}
          onChange={(e) => void change(e.target.value)}
          disabled={busy || models.length === 0}
        >
          {models.length === 0 && <option value="">{ja.models.none}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name} ({m.id})
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <button
          className="btn"
          type="button"
          onClick={() => void refresh()}
          disabled={busy || !configured}
        >
          {busy ? ja.models.refreshing : ja.models.refresh}
        </button>
        {list?.fetched_at && (
          <span className="muted">
            {ja.models.fetchedAt(new Date(list.fetched_at).toLocaleString('ja-JP'))}
          </span>
        )}
      </div>
      <Message message={message} />
    </section>
  )
}
