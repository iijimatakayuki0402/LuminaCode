import { useEffect, useId, useMemo, useState } from 'react'
import { SHORTCUTS } from '@shared/shortcuts'
import { ACCENTS, MODES } from '@shared/theme'
import type { AppInfo } from '@shared/ipc'
import type {
  ApiKeyStatus,
  Appearance,
  BackupInfo,
  ChatPrefs,
  LicenseList,
  ModelList,
  UpdateStatus,
  UsageLimits
} from '@shared/types'
import { ApiKeyForm } from '../components/ApiKeyForm'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Message, type MessageState } from '../components/Message'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

/**
 * 設定画面（要件 6.12）
 */
export function SettingsScreen({
  section,
  update,
  status,
  onStatusChange,
  appearance,
  onAppearanceChange,
  onOpenLogs
}: {
  /** 開いたときに表示する位置 */
  section?: 'about'
  /** 操作ログの画面を開く（期間を指定して削除する） */
  onOpenLogs: () => void
  update: UpdateStatus | null
  status: ApiKeyStatus
  onStatusChange: (status: ApiKeyStatus) => void
  appearance: Appearance
  onAppearanceChange: (appearance: Appearance) => void
}): React.JSX.Element {
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView()
  }, [section])

  return (
    <main className="screen">
      <h1 className="screen-title">SETTINGS</h1>
      <ApiKeySection status={status} onStatusChange={onStatusChange} />
      <ModelSection configured={status.configured} />
      <AppearanceSection appearance={appearance} onChange={onAppearanceChange} />
      <GlobalInstructionsSection />
      <ChatPrefsSection />
      <ShortcutsSection />
      <CoworkPrefsSection />
      <UsageLimitsSection />
      <DataSection onOpenLogs={onOpenLogs} />
      <BackupSection />
      <AboutSection update={update} />
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
 * 共通のカスタム指示（PRJ-08: グローバル → プロジェクトの順に結合して適用する）
 */
function GlobalInstructionsSection(): React.JSX.Element {
  const textId = useId()
  const [text, setText] = useState('')
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.instructions.get())
      .then((t) => active && setText(t))
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  const save = async (): Promise<void> => {
    try {
      setText(await unwrap(window.lumina.instructions.set(text)))
      setMessage({ tone: 'info', text: ja.instructions.saved })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-instructions">
      <h2 id="settings-instructions">{ja.instructions.section}</h2>
      <div className="field">
        <label htmlFor={textId}>{ja.instructions.label}</label>
        <textarea
          id={textId}
          className="input textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="hint">{ja.projectDialog.count([...text].length, 20000)}</span>
      </div>
      <button className="btn btn-primary" type="button" onClick={() => void save()}>
        {ja.common.save}
      </button>
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

/**
 * 使用量の上限（USG-03、USG-04）
 */
function UsageLimitsSection(): React.JSX.Element {
  const inputId = useId()
  const [limits, setLimits] = useState<UsageLimits | null>(null)
  const [value, setValue] = useState('')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([unwrap(window.lumina.usage.getLimits()), unwrap(window.lumina.app.getInfo())])
      .then(([l, i]) => {
        if (!active) return
        setLimits(l)
        setValue(l.monthlyLimit?.toString() ?? '')
        setInfo(i)
      })
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  const save = async (input: Partial<UsageLimits>): Promise<void> => {
    try {
      const next = await unwrap(window.lumina.usage.setLimits(input))
      setLimits(next)
      setValue(next.monthlyLimit?.toString() ?? '')
      setMessage({ tone: 'info', text: ja.usage.saved })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-usage">
      <h2 id="settings-usage">{ja.usage.settings}</h2>
      <div className="field">
        <label htmlFor={inputId}>{ja.usage.monthlyLimit}</label>
        <div className="row">
          <input
            id={inputId}
            className="input"
            style={{ width: '10rem' }}
            type="number"
            min={0}
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="btn"
            type="button"
            onClick={() => void save({ monthlyLimit: value === '' ? null : Number(value) })}
          >
            {ja.common.save}
          </button>
        </div>
      </div>
      <fieldset className="field" style={{ border: 'none', padding: 0 }}>
        <legend className="hint" style={{ marginBottom: '0.35rem' }}>
          {ja.usage.action}
        </legend>
        <div className="segmented">
          {(['stop', 'warn'] as const).map((action) => (
            <label key={action}>
              <input
                type="radio"
                name="usage-action"
                checked={limits?.action === action}
                onChange={() => void save({ action })}
              />
              {ja.usage.actions[action]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="hint">{ja.usage.disclaimer}</p>
      {info && (
        <p className="hint mono">
          {ja.usage.pricingFile(info.pricingPath)}
          <br />
          {ja.usage.pricingNote}
        </p>
      )}
      <Message message={message} />
    </section>
  )
}

/**
 * データ（6.12: データ保存先の表示、ログの削除）
 */
function DataSection({ onOpenLogs }: { onOpenLogs: () => void }): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)

  const clearAppLog = async (): Promise<void> => {
    setConfirmClear(false)
    try {
      await unwrap(window.lumina.logs.clearAppLog())
      setMessage({ tone: 'info', text: ja.data.appLogCleared })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  useEffect(() => {
    let active = true
    unwrap(window.lumina.app.getInfo())
      .then((i) => active && setInfo(i))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])
  return (
    <section className="panel" aria-labelledby="settings-data">
      <h2 id="settings-data">{ja.data.section}</h2>
      {info && (
        <p className="hint mono">
          {ja.data.dataPath(info.dataPath)}
          <br />
          {ja.data.logPath(info.logPath)}
        </p>
      )}
      <div className="row">
        <button className="btn" type="button" onClick={onOpenLogs}>
          {ja.data.openOperationLog}
        </button>
        <button className="btn btn-danger" type="button" onClick={() => setConfirmClear(true)}>
          {ja.data.clearAppLog}
        </button>
      </div>
      <p className="hint">{ja.data.logNote}</p>
      <Message message={message} />
      {confirmClear && (
        <ConfirmDialog
          title={ja.data.clearAppLog}
          message={ja.data.clearAppLogConfirm}
          confirmLabel={ja.data.clearAppLogButton}
          danger
          onConfirm={() => void clearAppLog()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </section>
  )
}

/**
 * バックアップ（10.2: 日次・7 世代。手動でも取れる）
 */
function BackupSection(): React.JSX.Element {
  const [list, setList] = useState<BackupInfo[]>([])
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.data.backupList())
      .then((l) => active && setList(l))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const backup = async (): Promise<void> => {
    try {
      const info = await unwrap(window.lumina.data.backupNow())
      setMessage({ tone: 'info', text: ja.backup.done(info.path) })
      setList(await unwrap(window.lumina.data.backupList()))
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-backup">
      <h2 id="settings-backup">{ja.backup.section}</h2>
      <p className="hint">{ja.backup.note}</p>
      {list.length === 0 ? (
        <p className="hint">{ja.backup.none}</p>
      ) : (
        <ul className="month-list mono">
          {list.map((b) => (
            <li key={b.path} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{new Date(b.created_at).toLocaleString('ja-JP')}</span>
              <span className="hint">{Math.ceil(b.size_bytes / 1024).toLocaleString()} KB</span>
            </li>
          ))}
        </ul>
      )}
      <button className="btn" type="button" onClick={() => void backup()}>
        {ja.backup.now}
      </button>
      <Message message={message} />
    </section>
  )
}

/**
 * キーボードショートカットの一覧（CMN-02）
 */
function ShortcutsSection(): React.JSX.Element {
  const [sendKey, setSendKey] = useState<ChatPrefs['sendKey']>('enter')
  useEffect(() => {
    let active = true
    unwrap(window.lumina.chatPrefs.get())
      .then((p) => active && setSendKey(p.sendKey))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return (
    <section className="panel" aria-labelledby="settings-shortcuts">
      <h2 id="settings-shortcuts">{ja.shortcuts.section}</h2>
      <dl className="shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.action}>
            <dt>
              <kbd>{s.keys}</kbd>
            </dt>
            <dd>{ja.shortcuts.actions[s.action]}</dd>
          </div>
        ))}
        <div>
          <dt>
            <kbd>{ja.shortcuts.sendKeys[sendKey]}</kbd>
          </dt>
          <dd>{ja.shortcuts.send}</dd>
        </div>
      </dl>
      <p className="hint">{ja.shortcuts.sendNote}</p>
    </section>
  )
}

/** 更新の状態の説明 */
function updateText(update: UpdateStatus | null): string {
  if (!update) return ja.update.unconfigured
  if (update.error) return update.error
  switch (update.state) {
    case 'available':
      return ja.update.available(update.version ?? '')
    case 'downloading':
      return ja.update.downloading(update.percent ?? 0)
    case 'downloaded':
      return ja.update.downloaded(update.version ?? '')
    case 'checking':
      return ja.update.checking
    case 'latest':
      return ja.update.latest
    case 'idle':
      return ja.update.idle
    default:
      return ja.update.unconfigured
  }
}

/**
 * アプリ情報（6.12: バージョン、更新確認、ライセンス表示。CMN-03）
 */
function AboutSection({ update }: { update: UpdateStatus | null }): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [licenses, setLicenses] = useState<LicenseList | null>(null)
  const [showLicenses, setShowLicenses] = useState(false)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([unwrap(window.lumina.app.getInfo()), unwrap(window.lumina.app.licenses())])
      .then(([i, l]) => {
        if (!active) return
        setInfo(i)
        setLicenses(l)
      })
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  // 状態の変化は App が受け取って渡す（ここでは操作の失敗だけを表示する）
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setMessage(null)
    try {
      await action()
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  const state = update?.state ?? 'unconfigured'

  return (
    <section className="panel" aria-labelledby="settings-about">
      <h2 id="settings-about">{ja.about.section}</h2>
      {info && (
        <p className="mono">
          {ja.about.version(info.version)}
          <br />
          <span className="hint">{ja.about.runtime(info.electron, info.chrome, info.node)}</span>
        </p>
      )}

      <h3 className="subhead">{ja.update.section}</h3>
      <p className={update?.error ? 'message message-error' : 'hint'} role="status">
        {updateText(update)}
      </p>
      {update?.checkedAt && (
        <p className="hint">
          {ja.update.checkedAt(new Date(update.checkedAt).toLocaleString('ja-JP'))}
        </p>
      )}
      {update?.releaseNotes && (state === 'available' || state === 'downloaded') && (
        <details style={{ marginBottom: '0.75rem' }}>
          <summary>{ja.update.notes}</summary>
          <div className="thinking-body">{update.releaseNotes}</div>
        </details>
      )}
      <div className="row">
        {state !== 'unconfigured' && state !== 'downloaded' && (
          <button
            className="btn"
            type="button"
            disabled={state === 'checking' || state === 'downloading'}
            onClick={() => void run(() => unwrap(window.lumina.update.check()))}
          >
            {state === 'checking' ? ja.update.checking : ja.update.check}
          </button>
        )}
        {/* CMN-03: ダウンロード・適用は、ユーザーの操作でのみ行う */}
        {state === 'available' && (
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void run(() => unwrap(window.lumina.update.download()))}
          >
            {ja.update.download}
          </button>
        )}
        {state === 'downloaded' && (
          <button className="btn btn-primary" type="button" onClick={() => setConfirmInstall(true)}>
            {ja.update.install}
          </button>
        )}
      </div>

      <h3 className="subhead">{ja.about.licenses}</h3>
      {licenses?.appLicense && <p className="hint">{ja.about.appLicense(licenses.appLicense)}</p>}
      {licenses && licenses.packages.length > 0 ? (
        <button className="btn" type="button" onClick={() => setShowLicenses(true)}>
          {ja.about.showLicenses(licenses.packages.length)}
        </button>
      ) : (
        <p className="hint">{ja.about.noLicenses}</p>
      )}
      <p className="hint">{ja.about.chromiumNote}</p>
      <Message message={message} />

      {showLicenses && licenses && (
        <LicensesDialog licenses={licenses} onClose={() => setShowLicenses(false)} />
      )}
      {confirmInstall && (
        <ConfirmDialog
          title={ja.update.installTitle}
          confirmLabel={ja.update.install}
          message={<p>{ja.update.installConfirm}</p>}
          onCancel={() => setConfirmInstall(false)}
          onConfirm={() => {
            setConfirmInstall(false)
            void run(() => unwrap(window.lumina.update.install()))
          }}
        />
      )}
    </section>
  )
}

function LicensesDialog({
  licenses,
  onClose
}: {
  licenses: LicenseList
  onClose: () => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return licenses.packages.filter((p) => p.name.toLowerCase().includes(q))
  }, [licenses, filter])

  return (
    <Dialog
      title={ja.about.licenses}
      onClose={onClose}
      footer={
        <button className="btn" type="button" onClick={onClose} autoFocus>
          {ja.about.close}
        </button>
      }
    >
      <input
        className="input"
        type="search"
        placeholder={ja.about.filter}
        aria-label={ja.about.filter}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul className="license-list">
        {visible.map((p) => (
          <li key={`${p.name}@${p.version}`}>
            <details>
              <summary className="mono">
                {p.name} {p.version} <span className="hint">— {p.license}</span>
              </summary>
              <pre className="license-text">{p.text ?? ja.about.noText}</pre>
            </details>
          </li>
        ))}
      </ul>
    </Dialog>
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
