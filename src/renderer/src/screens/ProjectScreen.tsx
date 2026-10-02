import { useCallback, useEffect, useId, useState } from 'react'
import { resolveModel } from '@shared/models'
import type {
  AlwaysAllowRules,
  EffortLevel,
  PermissionMode,
  Project,
  Thread,
  UsageStatus,
  UsageTotals
} from '@shared/types'
import { ConfirmDialog } from '../components/Dialog'
import { Message, type MessageState } from '../components/Message'
import { TypeBadge } from '../components/TypeBadge'
import { unwrap } from '../lib/ipc'
import { useModels } from '../lib/useModels'
import { ChatView } from './ChatView'
import { TrashDialog } from '../components/CoworkParts'
import { ja } from '../locales/ja'

const threadTitle = (thread: Thread): string => thread.title ?? ja.project.untitled

/**
 * プロジェクト画面（要件 6.3 スレッド管理、MDL-03・MDL-04）
 * 会話の送受信は Stage 5 で中央の領域に実装する。
 */
const PERMISSION_MODES: PermissionMode[] = ['confirm_each', 'auto_edit', 'plan_only']

export function ProjectScreen({
  project: initialProject,
  focus,
  onBack
}: {
  project: Project
  /** 検索結果から開いたときの移動先（SRC-01） */
  focus?: { threadId: string; messageId: string }
  onBack: () => void
}): React.JSX.Element {
  const [project, setProject] = useState(initialProject)
  const [always, setAlways] = useState<AlwaysAllowRules>({ thread: [], project: [] })
  const [trashOpen, setTrashOpen] = useState(false)
  const [usageStatus, setUsageStatus] = useState<UsageStatus | null>(null)
  const [threadUsage, setThreadUsage] = useState<UsageTotals | null>(null)
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<Thread | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)
  const { models, defaultModel } = useModels()
  const modelSelectId = useId()
  const effortSelectId = useId()

  const fail = (e: unknown): void => setMessage({ tone: 'error', text: (e as Error).message })

  const fetchThreads = useCallback(
    () => unwrap(window.lumina.threads.listByProject(project.id)),
    [project.id]
  )

  // THR-05: 最後に開いたスレッドを表示する（無ければ最新のスレッド）。検索結果から開いた場合はそのスレッド
  const focusThreadId = focus?.threadId
  useEffect(() => {
    let active = true
    Promise.all([fetchThreads(), unwrap(window.lumina.threads.getLastOpened(project.id))])
      .then(([list, last]) => {
        if (!active) return
        setThreads(list)
        setSelectedId(focusThreadId ?? last?.id ?? list[0]?.id ?? null)
      })
      .catch((e: unknown) => active && fail(e))
    return () => {
      active = false
    }
  }, [fetchThreads, project.id, focusThreadId])

  // 選択したスレッドを「最後に開いた」として記録する
  useEffect(() => {
    if (selectedId) void window.lumina.threads.markOpened(selectedId)
  }, [selectedId])

  const reload = async (): Promise<Thread[]> => {
    const list = await fetchThreads()
    setThreads(list)
    return list
  }

  const createThread = async (): Promise<void> => {
    setMessage(null)
    try {
      const thread = await unwrap(window.lumina.threads.create({ project_id: project.id }))
      await reload()
      setSelectedId(thread.id)
    } catch (e) {
      fail(e)
    }
  }

  const rename = async (): Promise<void> => {
    if (!renaming) return
    try {
      await unwrap(window.lumina.threads.update(renaming.id, { title: renaming.title.trim() }))
      setRenaming(null)
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  const remove = async (thread: Thread): Promise<void> => {
    try {
      await unwrap(window.lumina.threads.delete(thread.id))
      const list = await reload()
      if (selectedId === thread.id) setSelectedId(list[0]?.id ?? null)
    } catch (e) {
      fail(e)
    }
  }

  const changeEffort = async (thread: Thread, effort: EffortLevel | ''): Promise<void> => {
    try {
      await unwrap(window.lumina.threads.update(thread.id, { effort }))
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  const changeThreadModel = async (thread: Thread, model: string): Promise<void> => {
    try {
      await unwrap(window.lumina.threads.update(thread.id, { model }))
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  // 6.7: 「常に許可」の表示と解除
  useEffect(() => {
    if (project.type !== 'cowork') return
    let active = true
    unwrap(window.lumina.cowork.getAlways(project.id, selectedId ?? undefined))
      .then((rules) => active && setAlways(rules))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [project.id, project.type, selectedId, threads])

  // USG-02: スレッドの累計、USG-04: 上限の 80% で警告・100% で停止の表示
  useEffect(() => {
    let active = true
    Promise.all([
      unwrap(window.lumina.usage.status(project.id)),
      selectedId ? unwrap(window.lumina.usage.threadTotals(selectedId)) : Promise.resolve(null)
    ])
      .then(([s, t]) => {
        if (!active) return
        setUsageStatus(s)
        setThreadUsage(t)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [project.id, selectedId, threads])

  const clearAlways = async (scope: 'thread' | 'project'): Promise<void> => {
    try {
      const target = scope === 'thread' ? selectedId : project.id
      if (!target) return
      await unwrap(window.lumina.cowork.clearAlways(scope, target))
      setAlways(await unwrap(window.lumina.cowork.getAlways(project.id, selectedId ?? undefined)))
    } catch (e) {
      fail(e)
    }
  }

  const changeMode = async (mode: PermissionMode): Promise<void> => {
    try {
      setProject(await unwrap(window.lumina.projects.update(project.id, { permission_mode: mode })))
    } catch (e) {
      fail(e)
    }
  }

  const selected = threads?.find((t) => t.id === selectedId) ?? null
  const activeModelInfo = models.find(
    (m) => m.id === resolveModel(defaultModel, project.model, selected?.model ?? null)
  )
  const effortLevels = activeModelInfo?.effort_levels ?? []
  // MDL-03: スレッド → プロジェクト → 全体の既定
  const activeModel = resolveModel(defaultModel, project.model, selected?.model ?? null)
  const modelSource = selected?.model
    ? ja.project.modelSource.thread
    : project.model
      ? ja.project.modelSource.project
      : ja.project.modelSource.default

  return (
    <div className={`project-screen type-${project.type}`}>
      <div className="project-band">
        <button className="btn btn-sm" type="button" onClick={onBack}>
          ← {ja.project.back}
        </button>
        <TypeBadge type={project.type} />
        <h1>{project.name}</h1>
        {project.type === 'cowork' && (
          <>
            <span className="card-path" title={ja.project.workFolder}>
              {project.work_folder}
            </span>
            <button className="btn btn-sm" type="button" onClick={() => setTrashOpen(true)}>
              {ja.trash.open}
            </button>
          </>
        )}
      </div>

      <div className="workspace">
        <aside className="sidebar" aria-label={ja.project.threads}>
          <button className="btn btn-primary" type="button" onClick={() => void createThread()}>
            + {ja.project.newThread}
          </button>
          {threads !== null && threads.length === 0 && (
            <p className="hint">{ja.project.noThreads}</p>
          )}
          <ul className="thread-list">
            {(threads ?? []).map((t) => (
              <li key={t.id} className={`thread-item${t.id === selectedId ? ' selected' : ''}`}>
                {renaming?.id === t.id ? (
                  <form
                    className="row"
                    style={{ flex: 1, padding: '0.25rem' }}
                    onSubmit={(e) => {
                      e.preventDefault()
                      void rename()
                    }}
                  >
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 0 }}
                      aria-label={ja.project.rename}
                      value={renaming.title}
                      autoFocus
                      onChange={(e) => setRenaming({ id: t.id, title: e.target.value })}
                      onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                    />
                    <button className="btn btn-sm" type="submit">
                      {ja.project.renameSave}
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className="thread-open"
                      type="button"
                      aria-current={t.id === selectedId}
                      onClick={() => setSelectedId(t.id)}
                    >
                      {threadTitle(t)}
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      aria-label={`${ja.project.rename}: ${threadTitle(t)}`}
                      title={ja.project.rename}
                      onClick={() => setRenaming({ id: t.id, title: t.title ?? '' })}
                    >
                      ✎
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      type="button"
                      aria-label={`${ja.project.delete}: ${threadTitle(t)}`}
                      title={ja.project.delete}
                      onClick={() => setDeleting(t)}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <section className="content">
          {/* MDL-04: 現在のモデルを目立つ位置に常時表示する */}
          <div className="statusbar" role="status">
            <span>
              {ja.project.model}: <strong>{activeModel ?? ja.project.noModel}</strong>
            </span>
            {activeModel && <span className="muted">({modelSource})</span>}
            {threadUsage && threadUsage.requests > 0 && (
              <span className="muted">
                {ja.usage.threadTotal(
                  threadUsage.input_tokens +
                    threadUsage.output_tokens +
                    threadUsage.cache_read_tokens +
                    threadUsage.cache_write_tokens,
                  threadUsage.cost
                )}
              </span>
            )}
            {project.type === 'cowork' && (
              <>
                {/* COW-09: 権限モードを切り替える */}
                <label className="row" style={{ gap: '0.35rem' }}>
                  {ja.cowork.modeLabel}:
                  <select
                    className="select"
                    value={project.permission_mode}
                    onChange={(e) => void changeMode(e.target.value as PermissionMode)}
                  >
                    {PERMISSION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {ja.permissionMode[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <AlwaysRules always={always} onClear={(scope) => void clearAlways(scope)} />
              </>
            )}
          </div>
          {usageStatus && usageStatus.level !== 'ok' && (
            <p
              className={`message ${usageStatus.level === 'exceeded' && usageStatus.action === 'stop' ? 'message-error' : 'message-info'}`}
              role="status"
            >
              {usageStatus.level === 'warning'
                ? ja.usage.warning(Math.floor(usageStatus.ratio * 100))
                : usageStatus.action === 'stop'
                  ? ja.usage.exceededStop
                  : ja.usage.exceededWarn}
            </p>
          )}
          {project.type === 'cowork' && <p className="hint">{ja.cowork.commandLimit}</p>}

          <Message message={message} />

          {selected && (
            <>
              <div className="row thread-settings">
                <div className="field thread-model">
                  <label htmlFor={modelSelectId}>
                    {threadTitle(selected)} — {ja.project.threadModel}
                  </label>
                  <select
                    id={modelSelectId}
                    className="select mono"
                    value={selected.model ?? ''}
                    onChange={(e) => void changeThreadModel(selected, e.target.value)}
                  >
                    <option value="">
                      {ja.project.inherit(resolveModel(defaultModel, project.model, null))}
                    </option>
                    {selected.model && !models.some((m) => m.id === selected.model) && (
                      <option value={selected.model}>{selected.model}</option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name} ({m.id})
                      </option>
                    ))}
                  </select>
                </div>
                {/* EXP-02: スレッドを Markdown で書き出す */}
                <button
                  className="btn btn-sm"
                  type="button"
                  style={{ marginBottom: '0.5rem' }}
                  onClick={() =>
                    void unwrap(window.lumina.data.exportThreadMarkdown(selected.id))
                      .then(
                        (path) =>
                          path && setMessage({ tone: 'info', text: ja.exchange.exported(path) })
                      )
                      .catch(fail)
                  }
                >
                  {ja.exchange.exportMarkdown}
                </button>
                {/* CHT-07: 思考量（モデルが対応している段階だけを選べる） */}
                {effortLevels.length > 0 && (
                  <div className="field">
                    <label htmlFor={effortSelectId}>{ja.project.effort}</label>
                    <select
                      id={effortSelectId}
                      className="select"
                      title={ja.project.effortNote}
                      value={selected.effort ?? ''}
                      onChange={(e) =>
                        void changeEffort(selected, e.target.value as EffortLevel | '')
                      }
                    >
                      <option value="">{ja.project.effortDefault}</option>
                      {effortLevels.map((level) => (
                        <option key={level} value={level}>
                          {ja.project.effortLevels[level]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <ChatView
                threadId={selected.id}
                focusMessageId={focus?.threadId === selected.id ? focus.messageId : undefined}
                cowork={project.type === 'cowork'}
                onThreadChanged={() => void reload()}
                onCompacted={(next) => {
                  void reload().then(() => setSelectedId(next.id))
                }}
              />
            </>
          )}
        </section>
      </div>

      {trashOpen && <TrashDialog projectId={project.id} onClose={() => setTrashOpen(false)} />}

      {deleting && (
        <ConfirmDialog
          danger
          title={ja.project.deleteTitle}
          confirmLabel={ja.project.delete}
          message={<p>{ja.project.deleteMessage(threadTitle(deleting))}</p>}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting
            setDeleting(null)
            void remove(target)
          }}
        />
      )}
    </div>
  )
}

function AlwaysRules({
  always,
  onClear
}: {
  always: AlwaysAllowRules
  onClear: (scope: 'thread' | 'project') => void
}): React.JSX.Element {
  const scopes = (['thread', 'project'] as const).filter((s) => always[s].length > 0)
  return (
    <span className="row" style={{ gap: '0.5rem' }}>
      {ja.cowork.always}:
      {scopes.length === 0 && <span className="muted">{ja.cowork.alwaysNone}</span>}
      {scopes.map((scope) => (
        <span key={scope} className="row" style={{ gap: '0.25rem' }}>
          <span>
            {ja.cowork.alwaysScope[scope]}（
            {always[scope].map((c) => ja.cowork.category[c]).join('・')}）
          </span>
          <button className="btn btn-sm" type="button" onClick={() => onClear(scope)}>
            {ja.cowork.clear}
          </button>
        </span>
      ))}
    </span>
  )
}
