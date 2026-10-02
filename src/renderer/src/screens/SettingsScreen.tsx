import { useEffect, useId, useState } from 'react'
import { ACCENTS, MODES } from '@shared/theme'
import type { ApiKeyStatus, Appearance, ChatPrefs, ModelList } from '@shared/types'
import { ApiKeyForm } from '../components/ApiKeyForm'
import { Message, type MessageState } from '../components/Message'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

/**
 * 設定画面（要件 6.12 のうち API・モデル）
 */
export function SettingsScreen({
  status,
  onStatusChange,
  appearance,
  onAppearanceChange
}: {
  status: ApiKeyStatus
  onStatusChange: (status: ApiKeyStatus) => void
  appearance: Appearance
  onAppearanceChange: (appearance: Appearance) => void
}): React.JSX.Element {
  return (
    <main className="screen">
      <h1 className="screen-title">SETTINGS</h1>
      <ApiKeySection status={status} onStatusChange={onStatusChange} />
      <ModelSection configured={status.configured} />
      <AppearanceSection appearance={appearance} onChange={onAppearanceChange} />
      <ChatPrefsSection />
      <CoworkPrefsSection />
    </main>
  )
}

/**
 * 表示設定（要件 CMN-01、CMN-06: 変更は即時に反映し、再起動後も保持する）
 */
function AppearanceSection({
  appearance,
  onChange
}: {
  appearance: Appearance
  onChange: (appearance: Appearance) => void
}): React.JSX.Element {
  const [message, setMessage] = useState<MessageState | null>(null)

  const update = async (input: Partial<Appearance>): Promise<void> => {
    try {
      onChange(await unwrap(window.lumina.settings.setAppearance(input)))
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-appearance">
      <h2 id="settings-appearance">{ja.appearance.section}</h2>
      <fieldset className="field" style={{ border: 'none', padding: 0 }}>
        <legend className="hint" style={{ marginBottom: '0.35rem' }}>
          {ja.appearance.mode}
        </legend>
        <div className="segmented">
          {MODES.map((mode) => (
            <label key={mode}>
              <input
                type="radio"
                name="appearance-mode"
                checked={appearance.mode === mode}
                onChange={() => void update({ mode })}
              />
              {ja.appearance.modes[mode]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field" style={{ border: 'none', padding: 0 }}>
        <legend className="hint" style={{ marginBottom: '0.35rem' }}>
          {ja.appearance.accent}
        </legend>
        <div className="segmented">
          {ACCENTS.map((accent) => (
            <label key={accent}>
              <input
                type="radio"
                name="appearance-accent"
                checked={appearance.accent === accent}
                onChange={() => void update({ accent })}
              />
              <span className="swatch" style={{ background: SWATCH[accent] }} aria-hidden="true" />
              {ja.appearance.accents[accent]}
            </label>
          ))}
        </div>
      </fieldset>
      <Message message={message} />
    </section>
  )
}

/**
 * 入力の設定（CHT-09: 送信キーの入れ替え）
 */
function ChatPrefsSection(): React.JSX.Element {
  const [prefs, setPrefs] = useState<ChatPrefs | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.chatPrefs.get())
      .then((p) => active && setPrefs(p))
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  const update = async (sendKey: ChatPrefs['sendKey']): Promise<void> => {
    try {
      setPrefs(await unwrap(window.lumina.chatPrefs.set({ sendKey })))
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-chat">
      <h2 id="settings-chat">{ja.chat.sendKey}</h2>
      <div className="segmented">
        {(['enter', 'ctrl_enter'] as const).map((key) => (
          <label key={key}>
            <input
              type="radio"
              name="send-key"
              checked={prefs?.sendKey === key}
              onChange={() => void update(key)}
            />
            {ja.chat.sendKeys[key]}
          </label>
        ))}
      </div>
      <Message message={message} />
    </section>
  )
}

/**
 * Cowork のコマンドの拒否リスト・許可リスト（SEC-22、SEC-23: ユーザーが追加・編集できる）
 */
function CoworkPrefsSection(): React.JSX.Element {
  const denyId = useId()
  const allowId = useId()
  const [deny, setDeny] = useState('')
  const [allow, setAllow] = useState('')
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.cowork.getPrefs())
      .then((p) => {
        if (!active) return
        setDeny(p.denyPatterns.join('\n'))
        setAllow(p.allowCommands.join('\n'))
      })
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  const lines = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)

  const save = async (): Promise<void> => {
    try {
      const p = await unwrap(
        window.lumina.cowork.setPrefs({ denyPatterns: lines(deny), allowCommands: lines(allow) })
      )
      setDeny(p.denyPatterns.join('\n'))
      setAllow(p.allowCommands.join('\n'))
      setMessage({ tone: 'info', text: ja.cowork.prefsSaved })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-cowork">
      <h2 id="settings-cowork">{ja.cowork.prefsSection}</h2>
      <p className="hint">{ja.cowork.commandLimit}</p>
      <div className="field">
        <label htmlFor={denyId}>{ja.cowork.denyPatterns}</label>
        <textarea
          id={denyId}
          className="input textarea mono"
          value={deny}
          spellCheck={false}
          onChange={(e) => setDeny(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={allowId}>{ja.cowork.allowCommands}</label>
        <textarea
          id={allowId}
          className="input textarea mono"
          value={allow}
          spellCheck={false}
          placeholder={'git status\nnpm test*'}
          onChange={(e) => setAllow(e.target.value)}
        />
      </div>
      <button className="btn btn-primary" type="button" onClick={() => void save()}>
        {ja.common.save}
      </button>
      <Message message={message} />
    </section>
  )
}

// 選択肢の見本色（10.3.1 のライト用の値）
const SWATCH: Record<Appearance['accent'], string> = {
  purple: '#8b6fd6',
  cyan: '#2a9dd6',
  red: '#e0707a'
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
