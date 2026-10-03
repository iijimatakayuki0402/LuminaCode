import { useCallback, useEffect, useId, useState } from 'react'
import { resolveModel } from '@shared/models'
import {
  THREAD_COLORS,
  type AlwaysAllowRules,
  type EffortLevel,
  type PermissionMode,
  type Project,
  type Thread,
  type ThreadColor,
  type UsageStatus,
  type UsageTotals
} from '@shared/types'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Message, type MessageState } from '../components/Message'
import { TypeBadge } from '../components/TypeBadge'
import { unwrap } from '../lib/ipc'
import { useModels } from '../lib/useModels'
import { useShortcuts } from '../lib/useShortcuts'
import { ChatView } from './ChatView'
import { TrashDialog } from '../components/CoworkParts'
import { CoworkSidePanel } from '../components/CoworkSidePanel'
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
  /** THR-06: 色ラベル・タグを編集中のスレッド。THR-07: 絞り込み */
  const [labeling, setLabeling] = useState<Thread | null>(null)
  const [filterColor, setFilterColor] = useState<ThreadColor | ''>('')
  const [filterTag, setFilterTag] = useState('')
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

  // CMN-02: Ctrl+N で新しいスレッドを作る
  useShortcuts({ newThread: () => void createThread() })

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

  // CHT-11: 通常チャットの Web 検索（Cowork は右パネルで設定する）
  const [webAccess, setWebAccess] = useState<boolean | null>(null)
  useEffect(() => {
    if (project.type !== 'chat') return
    let active = true
    unwrap(window.lumina.cowork.getSettings(project.id))
      .then((s) => active && setWebAccess(s.webAccess))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [project.id, project.type])
  const changeWebAccess = async (on: boolean): Promise<void> => {
    try {
      setWebAccess(
        (await unwrap(window.lumina.cowork.setSettings(project.id, { webAccess: on }))).webAccess
      )
    } catch (e) {
      fail(e)
    }
  }

  const changeThinking = async (thread: Thread, on: boolean): Promise<void> => {
    try {
      await unwrap(window.lumina.threads.update(thread.id, { extended_thinking: on }))
      await reload()
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

  const saveLabels = async (
    thread: Thread,
    color: ThreadColor | '',
    tags: string[]
  ): Promise<void> => {
    try {
      await unwrap(window.lumina.threads.update(thread.id, { color, tags }))
      setLabeling(null)
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  // THR-07: 色ラベル・タグで絞り込む（使われている色・タグだけを選べる）
  const usedColors = THREAD_COLORS.filter((c) => (threads ?? []).some((t) => t.color === c))
  const usedTags = [...new Set((threads ?? []).flatMap((t) => t.tags))].sort((a, b) =>
    a.localeCompare(b, 'ja')
  )
  const shownThreads = (threads ?? []).filter(
    (t) => (!filterColor || t.color === filterColor) && (!filterTag || t.tags.includes(filterTag))
  )

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

      <div className={`workspace${project.type === 'cowork' ? ' with-panel' : ''}`}>
        <aside className="sidebar" aria-label={ja.project.threads}>
          <button className="btn btn-primary" type="button" onClick={() => void createThread()}>
            + {ja.project.newThread}
          </button>
          {threads !== null && threads.length === 0 && (
            <p className="hint">{ja.project.noThreads}</p>
          )}
          {(usedColors.length > 0 || usedTags.length > 0 || filterColor || filterTag) && (
            <div className="thread-filter" role="group" aria-label={ja.project.filter}>
              <select
                className="select"
                aria-label={ja.project.filterColor}
                value={filterColor}
                onChange={(e) => setFilterColor(e.target.value as ThreadColor | '')}
              >
                <option value="">{ja.project.allColors}</option>
                {THREAD_COLORS.filter((c) => usedColors.includes(c) || c === filterColor).map(
                  (c) => (
                    <option key={c} value={c}>
                      {ja.project.colors[c]}
                    </option>
                  )
                )}
              </select>
              <select
                className="select"
                aria-label={ja.project.filterTag}
                value={filterTag}
                onChange={(e) => setFilterTag(e.target.value)}
              >
                <option value="">{ja.project.allTags}</option>
                {[...new Set([...usedTags, ...(filterTag ? [filterTag] : [])])].map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </div>
          )}
          {threads !== null && threads.length > 0 && shownThreads.length === 0 && (
            <p className="hint">{ja.project.noMatch}</p>
          )}
          <ul className="thread-list">
            {shownThreads.map((t) => (
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
                      onKeyDown={(e) => {
                        if (e.key !== 'Escape') return
                        // 生成の停止（Esc）には使わない
                        e.preventDefault()
                        setRenaming(null)
                      }}
                    />
                    <button className="btn btn-sm" type="submit">
                      {ja.project.renameSave}
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="thread-main">
                      <button
                        className="thread-open"
                        type="button"
                        aria-current={t.id === selectedId}
                        onClick={() => setSelectedId(t.id)}
                      >
                        {t.color && (
                          <span
                            className={`label-dot color-${t.color}`}
                            role="img"
                            aria-label={`${ja.project.color}: ${ja.project.colors[t.color]}`}
                            title={ja.project.colors[t.color]}
                          />
                        )}
                        <span className="thread-title">{threadTitle(t)}</span>
                      </button>
                      {t.tags.length > 0 && (
                        <span className="thread-tags" aria-label={ja.project.tags}>
                          {t.tags.map((tag) => (
                            <span key={tag} className="tag-chip">
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <button
                      className="btn btn-sm"
                      type="button"
                      aria-label={ja.project.labelsTitle(threadTitle(t))}
                      title={ja.project.labels}
                      onClick={() => setLabeling(t)}
                    >
                      ◆
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
                {/* CHT-07: 拡張思考のオン／オフ（通常チャットで、モデルが対応している場合） */}
                {project.type === 'chat' && activeModelInfo?.supports_adaptive_thinking && (
                  <label className="check" title={ja.project.thinkingNote}>
                    <input
                      type="checkbox"
                      checked={selected.extended_thinking}
                      onChange={(e) => void changeThinking(selected, e.target.checked)}
                    />
                    {ja.project.thinking}
                  </label>
                )}
                {/* CHT-11: Web 検索（通常チャット。プロジェクトごと、既定はオフ） */}
                {project.type === 'chat' && webAccess !== null && (
                  <label className="check" title={ja.project.webSearchNote}>
                    <input
                      type="checkbox"
                      checked={webAccess}
                      onChange={(e) => void changeWebAccess(e.target.checked)}
                    />
                    {ja.project.webSearch}
                  </label>
                )}
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
                key={selected.id}
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
        {project.type === 'cowork' && <CoworkSidePanel projectId={project.id} />}
      </div>

      {trashOpen && <TrashDialog projectId={project.id} onClose={() => setTrashOpen(false)} />}

      {labeling && (
        <LabelsDialog
          thread={labeling}
          onCancel={() => setLabeling(null)}
          onSave={(color, tags) => void saveLabels(labeling, color, tags)}
        />
      )}

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

/**
 * スレッドの色ラベルとタグの編集（THR-06）
 */
function LabelsDialog({
  thread,
  onCancel,
  onSave
}: {
  thread: Thread
  onCancel: () => void
  onSave: (color: ThreadColor | '', tags: string[]) => void
}): React.JSX.Element {
  const [color, setColor] = useState<ThreadColor | ''>(thread.color ?? '')
  const [tags, setTags] = useState(thread.tags.join(', '))
  const tagsId = useId()
  const formId = useId()
  const save = (): void =>
    onSave(
      color,
      tags
        .split(/[,、]/)
        .map((t) => t.trim())
        .filter((t) => t !== '')
    )
  return (
    <Dialog
      title={ja.project.labelsTitle(threadTitle(thread))}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" type="button" onClick={onCancel}>
            {ja.common.cancel}
          </button>
          <button className="btn btn-primary" type="submit" form={formId}>
            {ja.common.save}
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <fieldset className="field">
          <legend>{ja.project.color}</legend>
          <div className="color-choices">
            {(['', ...THREAD_COLORS] as const).map((c) => (
              <label key={c || 'none'} className="check">
                <input
                  type="radio"
                  name="thread-color"
                  checked={color === c}
                  onChange={() => setColor(c)}
                />
                {c && <span className={`label-dot color-${c}`} aria-hidden="true" />}
                {c ? ja.project.colors[c] : ja.project.noColor}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor={tagsId}>{ja.project.tags}</label>
          <input
            id={tagsId}
            className="input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
          <span className="hint">{ja.project.tagsNote}</span>
        </div>
      </form>
    </Dialog>
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
