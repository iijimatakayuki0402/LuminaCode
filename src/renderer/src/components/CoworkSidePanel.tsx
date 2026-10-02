import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  CoworkProjectSettings,
  GitSnapshot,
  GitStatus,
  FileEntry,
  FilePreview,
  McpServer,
  McpServerSummary,
  SkillsStatus
} from '@shared/types'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'
import { ConfirmDialog, Dialog } from './Dialog'

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`

/**
 * Cowork のプロジェクト画面の右側のパネル（ファイルツリー COW-08、拡張 6.6）
 */
export function CoworkSidePanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [tab, setTab] = useState<'files' | 'extensions'>('files')
  return (
    <aside className="side-panel" aria-label={ja.panel.label}>
      <div className="tabs" role="tablist">
        {(['files', 'extensions'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {ja.panel.tabs[t]}
          </button>
        ))}
      </div>
      {tab === 'files' ? <FileTree projectId={projectId} /> : <Extensions projectId={projectId} />}
      {/* SEC-24: コマンド実行の制約を常に示す */}
      <p className="hint panel-note">{ja.cowork.commandLimit}</p>
    </aside>
  )
}

// ========================================
// ファイルツリー（COW-08: 読み取り専用）
// ========================================

function FileTree({ projectId }: { projectId: string }): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, FileEntry[] | undefined>>({})
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (path: string): Promise<void> => {
      try {
        const entries = await unwrap(window.lumina.cowork.listDir(projectId, path))
        setOpen((map) => ({ ...map, [path]: entries }))
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [projectId]
  )

  useEffect(() => {
    let active = true
    unwrap(window.lumina.cowork.listDir(projectId, ''))
      .then((entries) => active && setOpen({ '': entries }))
      .catch((e: unknown) => active && setError((e as Error).message))
    return () => {
      active = false
    }
  }, [projectId])

  // Cowork の実行が終わったら、開いているフォルダを読み直す（作成・削除したファイルを反映する）
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])
  useEffect(
    () =>
      window.lumina.chat.onEvent((event) => {
        if (event.type !== 'finished') return
        for (const path of Object.keys(openRef.current)) void load(path)
      }),
    [load]
  )

  const toggle = (entry: FileEntry): void => {
    if (entry.isLink) return
    if (!entry.isDir) {
      void unwrap(window.lumina.cowork.preview(projectId, entry.path))
        .then(setPreview)
        .catch((e: unknown) => setError((e as Error).message))
      return
    }
    if (open[entry.path]) {
      setOpen((map) => {
        const next = { ...map }
        for (const key of Object.keys(next)) {
          if (
            key === entry.path ||
            key.startsWith(`${entry.path}\\`) ||
            key.startsWith(`${entry.path}/`)
          ) {
            delete next[key]
          }
        }
        return next
      })
    } else {
      void load(entry.path)
    }
  }

  const render = (path: string, depth: number): React.ReactNode =>
    (open[path] ?? []).map((entry) => (
      <li key={entry.path}>
        <button
          type="button"
          className="tree-item"
          style={{ paddingLeft: `${0.4 + depth * 0.9}rem` }}
          onClick={() => toggle(entry)}
          title={entry.isLink ? ja.panel.linkNote : entry.path}
          aria-expanded={entry.isDir ? !!open[entry.path] : undefined}
        >
          <span className="tree-icon" aria-hidden="true">
            {entry.isLink ? '↪' : entry.isDir ? (open[entry.path] ? '▾' : '▸') : '·'}
          </span>
          <span className="tree-name">{entry.name}</span>
          {!entry.isDir && !entry.isLink && (
            <span className="hint">{formatSize(entry.size_bytes)}</span>
          )}
        </button>
        {entry.isDir && open[entry.path] && (
          <ul className="tree">{render(entry.path, depth + 1)}</ul>
        )}
      </li>
    ))

  return (
    <div className="panel-body">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hint">{ja.panel.readOnly}</span>
        <button className="btn btn-sm" type="button" onClick={() => void load('')}>
          {ja.panel.refresh}
        </button>
      </div>
      {error && <p className="hint">{error}</p>}
      <ul className="tree">{render('', 0)}</ul>
      {preview && (
        <Dialog
          title={preview.path}
          onClose={() => setPreview(null)}
          footer={
            <button className="btn" type="button" onClick={() => setPreview(null)} autoFocus>
              {ja.common.back}
            </button>
          }
        >
          {preview.kind === 'text' ? (
            <>
              <pre className="file-preview">{preview.text}</pre>
              {preview.truncated && <p className="hint">{ja.panel.truncated}</p>}
            </>
          ) : preview.kind === 'image' ? (
            <img src={preview.dataUrl} alt={preview.path} className="image-preview" />
          ) : (
            <p className="hint">{ja.panel.unsupported(formatSize(preview.size_bytes))}</p>
          )}
        </Dialog>
      )}
    </div>
  )
}

// ========================================
// 拡張（6.6: Web アクセス・スキル・MCP）
// ========================================

function Extensions({ projectId }: { projectId: string }): React.JSX.Element {
  const [settings, setSettings] = useState<CoworkProjectSettings | null>(null)
  const [skills, setSkills] = useState<SkillsStatus | null>(null)
  const [servers, setServers] = useState<McpServerSummary[]>([])
  const [adding, setAdding] = useState(false)
  const [confirmTrust, setConfirmTrust] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([
      unwrap(window.lumina.cowork.getSettings(projectId)),
      unwrap(window.lumina.cowork.skills(projectId)),
      unwrap(window.lumina.cowork.mcpList(projectId))
    ])
      .then(([s, k, m]) => {
        if (!active) return
        setSettings(s)
        setSkills(k)
        setServers(m)
      })
      .catch((e: unknown) => active && setMessage((e as Error).message))
    return () => {
      active = false
    }
  }, [projectId])

  const run = async <T,>(task: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
    setMessage(null)
    try {
      apply(await task())
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  return (
    <div className="panel-body">
      <section>
        <h3 className="panel-heading">{ja.panel.web}</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={settings?.webAccess ?? false}
            onChange={(e) =>
              void run(
                () =>
                  unwrap(
                    window.lumina.cowork.setSettings(projectId, { webAccess: e.target.checked })
                  ),
                setSettings
              )
            }
          />
          {ja.panel.webToggle}
        </label>
        <p className="hint">{ja.panel.webNote}</p>
      </section>

      <GitSection projectId={projectId} />

      <section>
        <h3 className="panel-heading">{ja.panel.skills}</h3>
        {!skills || skills.skills.length === 0 ? (
          <p className="hint">{ja.panel.noSkills}</p>
        ) : (
          <>
            <ul className="plain-list">
              {skills.skills.map((s) => (
                <li key={s.name}>
                  <span className="mono">{s.name}</span>
                  {s.description && <span className="hint"> — {s.description}</span>}
                </li>
              ))}
            </ul>
            {skills.trusted ? (
              <div className="row">
                <span className="hint">{ja.panel.skillsTrusted}</span>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() =>
                    void run(
                      () => unwrap(window.lumina.cowork.trustSkills(projectId, false)),
                      setSkills
                    )
                  }
                >
                  {ja.panel.disable}
                </button>
              </div>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                type="button"
                onClick={() => setConfirmTrust(true)}
              >
                {ja.panel.enableSkills}
              </button>
            )}
          </>
        )}
      </section>

      <section>
        <h3 className="panel-heading">{ja.panel.mcp}</h3>
        {servers.length === 0 && <p className="hint">{ja.panel.noMcp}</p>}
        <ul className="plain-list">
          {servers.map((s) => (
            <li key={s.name} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                <span className="mono">{s.name}</span>{' '}
                <span className="hint">
                  {s.type === 'stdio' ? `${s.command} ${s.args.join(' ')}` : s.url}
                </span>
              </span>
              <button
                className="btn btn-sm btn-danger"
                type="button"
                onClick={() =>
                  void run(
                    () => unwrap(window.lumina.cowork.mcpRemove(projectId, s.name)),
                    setServers
                  )
                }
              >
                {ja.panel.remove}
              </button>
            </li>
          ))}
        </ul>
        <button className="btn btn-sm" type="button" onClick={() => setAdding(true)}>
          {ja.panel.addMcp}
        </button>
      </section>
      {message && <p className="hint">{message}</p>}

      {confirmTrust && skills && (
        <ConfirmDialog
          danger
          title={ja.panel.trustTitle}
          confirmLabel={ja.panel.enableSkills}
          message={
            <>
              <p>{ja.panel.trustMessage}</p>
              <ul>
                {skills.skills.map((s) => (
                  <li key={s.name} className="mono">
                    {s.name}
                  </li>
                ))}
              </ul>
            </>
          }
          onCancel={() => setConfirmTrust(false)}
          onConfirm={() => {
            setConfirmTrust(false)
            void run(() => unwrap(window.lumina.cowork.trustSkills(projectId, true)), setSkills)
          }}
        />
      )}
      {adding && (
        <McpDialog
          onCancel={() => setAdding(false)}
          onSave={(server) =>
            void run(
              () => unwrap(window.lumina.cowork.mcpUpsert(projectId, server)),
              (list) => {
                setServers(list)
                setAdding(false)
              }
            )
          }
        />
      )}
    </div>
  )
}

/** key=value を 1 行ずつ */
const parsePairs = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  )

/**
 * MCP サーバーの追加（6.6: 実行されるコマンドを示して、信頼の確認を経る）
 */
function McpDialog({
  onSave,
  onCancel
}: {
  onSave: (server: McpServer) => void
  onCancel: () => void
}): React.JSX.Element {
  const ids = { name: useId(), command: useId(), args: useId(), env: useId(), url: useId() }
  const [type, setType] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [confirm, setConfirm] = useState(false)

  const server: McpServer =
    type === 'stdio'
      ? {
          name: name.trim(),
          type,
          command: command.trim(),
          args: args.trim() ? args.trim().split(/\s+/) : [],
          env: parsePairs(env)
        }
      : { name: name.trim(), type, url: url.trim(), headers: parsePairs(env) }

  return (
    <>
      <Dialog
        title={ja.panel.addMcp}
        onClose={onCancel}
        footer={
          <>
            <button className="btn" type="button" onClick={onCancel}>
              {ja.common.cancel}
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!name.trim() || (type === 'stdio' ? !command.trim() : !url.trim())}
              onClick={() => setConfirm(true)}
            >
              {ja.panel.addMcp}
            </button>
          </>
        }
      >
        <div className="segmented" style={{ marginBottom: '0.75rem' }}>
          {(['stdio', 'http'] as const).map((t) => (
            <label key={t}>
              <input
                type="radio"
                name="mcp-type"
                checked={type === t}
                onChange={() => setType(t)}
              />
              {ja.panel.mcpTypes[t]}
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor={ids.name}>{ja.panel.mcpName}</label>
          <input
            id={ids.name}
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {type === 'stdio' ? (
          <>
            <div className="field">
              <label htmlFor={ids.command}>{ja.panel.mcpCommand}</label>
              <input
                id={ids.command}
                className="input mono"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.args}>{ja.panel.mcpArgs}</label>
              <input
                id={ids.args}
                className="input mono"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor={ids.url}>URL</label>
            <input
              id={ids.url}
              className="input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor={ids.env}>
            {type === 'stdio' ? ja.panel.mcpEnv : ja.panel.mcpHeaders}
          </label>
          <textarea
            id={ids.env}
            className="input textarea mono"
            placeholder="KEY=value"
            value={env}
            spellCheck={false}
            onChange={(e) => setEnv(e.target.value)}
          />
          <span className="hint">{ja.panel.mcpSecretNote}</span>
        </div>
      </Dialog>
      {confirm && (
        <ConfirmDialog
          danger
          title={ja.panel.mcpTrustTitle}
          confirmLabel={ja.panel.mcpTrustConfirm}
          message={
            <>
              <p>{type === 'stdio' ? ja.panel.mcpTrustStdio : ja.panel.mcpTrustHttp}</p>
              <pre className="command-preview">
                {server.type === 'stdio'
                  ? `${server.command} ${server.args.join(' ')}`
                  : server.url}
              </pre>
            </>
          }
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false)
            onSave(server)
          }}
        />
      )}
    </>
  )
}

// ========================================
// Git のスナップショット（COW-10）
// ========================================

function GitSection({ projectId }: { projectId: string }): React.JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ snapshot: GitSnapshot; text: string } | null>(null)
  const [restoring, setRestoring] = useState<GitSnapshot | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setStatus(await unwrap(window.lumina.cowork.gitStatus(projectId)))
    } catch (e) {
      setMessage((e as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    let active = true
    unwrap(window.lumina.cowork.gitStatus(projectId))
      .then((s) => active && setStatus(s))
      .catch((e: unknown) => active && setMessage((e as Error).message))
    // 実行が終わったら一覧を読み直す（実行前のスナップショットが増える）
    const off = window.lumina.chat.onEvent((event) => {
      if (event.type === 'finished') void reload()
    })
    return () => {
      active = false
      off()
    }
  }, [projectId, reload])

  if (!status) return null

  const toggle = async (on: boolean): Promise<void> => {
    setMessage(null)
    try {
      await unwrap(window.lumina.cowork.setSettings(projectId, { gitSnapshots: on }))
      await reload()
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  const showDiff = async (snapshot: GitSnapshot): Promise<void> => {
    setMessage(null)
    try {
      const text = await unwrap(window.lumina.cowork.gitDiff(projectId, snapshot.ref))
      setDiff({ snapshot, text })
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  const restore = async (snapshot: GitSnapshot): Promise<void> => {
    setRestoring(null)
    setMessage(null)
    try {
      const { trashed } = await unwrap(window.lumina.cowork.gitRestore(projectId, snapshot.ref))
      setMessage(ja.git.restored(trashed))
      await reload()
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  return (
    <section>
      <h3 className="panel-heading">{ja.git.title}</h3>
      {!status.available ? (
        <p className="hint">{ja.git.unavailable}</p>
      ) : !status.repo ? (
        <p className="hint">{ja.git.notRepo}</p>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={status.enabled}
              onChange={(e) => void toggle(e.target.checked)}
            />
            {ja.git.toggle}
          </label>
          <p className="hint">{ja.git.note}</p>
          {status.snapshots.length === 0 ? (
            <p className="hint">{ja.git.none}</p>
          ) : (
            <ul className="plain-list">
              {status.snapshots.slice(0, 10).map((s) => (
                <li key={s.ref}>
                  <span className="hint" title={s.message}>
                    {new Date(s.created_at).toLocaleString('ja-JP')} {s.message}
                  </span>
                  <span className="row">
                    <button className="btn btn-sm" type="button" onClick={() => void showDiff(s)}>
                      {ja.git.diff}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      type="button"
                      onClick={() => setRestoring(s)}
                    >
                      {ja.git.restore}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message && <p className="hint">{message}</p>}
      {diff && (
        <Dialog
          title={ja.git.diffTitle}
          onClose={() => setDiff(null)}
          footer={
            <button className="btn" type="button" onClick={() => setDiff(null)} autoFocus>
              {ja.common.back}
            </button>
          }
        >
          <p className="hint">
            {new Date(diff.snapshot.created_at).toLocaleString('ja-JP')} {diff.snapshot.message}
          </p>
          <pre className="file-preview">{diff.text.trim() || ja.git.noDiff}</pre>
        </Dialog>
      )}
      {restoring && (
        <ConfirmDialog
          title={ja.git.restoreTitle}
          message={ja.git.restoreConfirm(new Date(restoring.created_at).toLocaleString('ja-JP'))}
          confirmLabel={ja.git.restore}
          danger
          onConfirm={() => void restore(restoring)}
          onCancel={() => setRestoring(null)}
        />
      )}
    </section>
  )
}
