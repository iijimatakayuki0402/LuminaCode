import { useCallback, useEffect, useId, useState } from 'react'
import { resolveModel } from '@shared/models'
import type { Project, Thread } from '@shared/types'
import { ConfirmDialog } from '../components/Dialog'
import { Message, type MessageState } from '../components/Message'
import { TypeBadge } from '../components/TypeBadge'
import { unwrap } from '../lib/ipc'
import { useModels } from '../lib/useModels'
import { ja } from '../locales/ja'

const threadTitle = (thread: Thread): string => thread.title ?? ja.project.untitled

/**
 * プロジェクト画面（要件 6.3 スレッド管理、MDL-03・MDL-04）
 * 会話の送受信は Stage 5 で中央の領域に実装する。
 */
export function ProjectScreen({
  project,
  onBack
}: {
  project: Project
  onBack: () => void
}): React.JSX.Element {
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<Thread | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)
  const { models, defaultModel } = useModels()
  const modelSelectId = useId()

  const fail = (e: unknown): void => setMessage({ tone: 'error', text: (e as Error).message })

  const fetchThreads = useCallback(
    () => unwrap(window.lumina.threads.listByProject(project.id)),
    [project.id]
  )

  // THR-05: 最後に開いたスレッドを表示する（無ければ最新のスレッド）
  useEffect(() => {
    let active = true
    Promise.all([fetchThreads(), unwrap(window.lumina.threads.getLastOpened(project.id))])
      .then(([list, last]) => {
        if (!active) return
        setThreads(list)
        setSelectedId(last?.id ?? list[0]?.id ?? null)
      })
      .catch((e: unknown) => active && fail(e))
    return () => {
      active = false
    }
  }, [fetchThreads, project.id])

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

  const changeThreadModel = async (thread: Thread, model: string): Promise<void> => {
    try {
      await unwrap(window.lumina.threads.update(thread.id, { model }))
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  const selected = threads?.find((t) => t.id === selectedId) ?? null
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
          <span className="card-path" title={ja.project.workFolder}>
            {project.work_folder}
          </span>
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
            {project.type === 'cowork' && (
              <span>
                {ja.project.permissionMode}:{' '}
                <strong>{ja.permissionMode[project.permission_mode]}</strong>
              </span>
            )}
          </div>

          <Message message={message} />

          {selected && (
            <>
              <h2 style={{ marginTop: 0 }}>{threadTitle(selected)}</h2>
              <div className="field" style={{ maxWidth: '32rem' }}>
                <label htmlFor={modelSelectId}>{ja.project.threadModel}</label>
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
              <p className="empty">{ja.project.chatComingSoon}</p>
            </>
          )}
        </section>
      </div>

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
