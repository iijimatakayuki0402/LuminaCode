import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImportPreview, Project, ProjectType } from '@shared/types'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Message, type MessageState } from '../components/Message'
import { ImportDialog } from '../components/ImportDialog'
import { ProjectDialog, type ProjectDialogMode } from '../components/ProjectDialog'
import { TypeBadge } from '../components/TypeBadge'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

type SortKey = 'updated' | 'created' | 'name'

const formatDate = (epoch: number): string =>
  new Date(epoch).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })

/**
 * ダッシュボード（要件 6.1）
 */
export function DashboardScreen({
  openCreate = false,
  apiKeyConfigured,
  onOpen,
  onOpenSettings
}: {
  /** 新規プロジェクトのダイアログを開いた状態で表示する（CMN-02: Ctrl+Shift+N） */
  openCreate?: boolean
  apiKeyConfigured: boolean
  onOpen: (project: Project) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<ProjectType | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('updated')
  const [showArchived, setShowArchived] = useState(false)
  const [dialog, setDialog] = useState<ProjectDialogMode | null>(
    openCreate ? { kind: 'create' } : null
  )
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)
  const [importing, setImporting] = useState<ImportPreview | null>(null)
  // PRJ-09: テンプレートとして保存するプロジェクトと、テンプレートの名前
  const [templating, setTemplating] = useState<{ project: Project; name: string } | null>(null)

  const saveTemplate = async (): Promise<void> => {
    if (!templating) return
    try {
      await unwrap(window.lumina.templates.saveFromProject(templating.project.id, templating.name))
      setMessage({ tone: 'info', text: ja.templates.saved(templating.name.trim()) })
      setTemplating(null)
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
      setTemplating(null)
    }
  }

  // EXP-01: 読み込むファイルを選び、内容を確認してから読み込む
  const startImport = async (): Promise<void> => {
    setMessage(null)
    try {
      const preview = await unwrap(window.lumina.data.importSelect())
      if (preview) setImporting(preview)
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  const exportProject = async (project: Project): Promise<void> => {
    try {
      const path = await unwrap(window.lumina.data.exportProject(project.id))
      if (path) setMessage({ tone: 'info', text: ja.exchange.exported(path) })
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  const fetchProjects = useCallback(
    () => unwrap(window.lumina.projects.list({ includeArchived: showArchived })),
    [showArchived]
  )

  useEffect(() => {
    let active = true
    fetchProjects()
      .then((list) => active && setProjects(list))
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [fetchProjects])

  const reload = async (): Promise<void> => {
    try {
      setProjects(await fetchProjects())
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setMessage(null)
    try {
      await action()
      await reload()
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  // DSH-06: 並び替え・種別フィルタ・名前検索（ピン留めは常に先頭）
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (projects ?? []).filter(
      (p) => (typeFilter === 'all' || p.type === typeFilter) && p.name.toLowerCase().includes(q)
    )
    const compare: Record<SortKey, (a: Project, b: Project) => number> = {
      updated: (a, b) => b.updated_at - a.updated_at,
      created: (a, b) => b.created_at - a.created_at,
      name: (a, b) => a.name.localeCompare(b.name, 'ja')
    }
    return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || compare[sort](a, b))
  }, [projects, query, typeFilter, sort])

  return (
    <main className="screen" style={{ maxWidth: '72rem' }}>
      <h1 className="screen-title">{ja.dashboard.title}</h1>

      {!apiKeyConfigured && (
        <p className="message message-info">
          {ja.apiKey.requiredNotice}{' '}
          <button className="btn btn-link" type="button" onClick={onOpenSettings}>
            {ja.apiKey.goSettings}
          </button>
        </p>
      )}

      <div className="toolbar">
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => setDialog({ kind: 'create' })}
        >
          + {ja.dashboard.create}
        </button>
        <button className="btn" type="button" onClick={() => void startImport()}>
          {ja.exchange.importProject}
        </button>
        <input
          className="input"
          type="search"
          placeholder={ja.dashboard.search}
          aria-label={ja.dashboard.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select"
          aria-label={ja.projectDialog.type}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as ProjectType | 'all')}
        >
          <option value="all">{ja.dashboard.filterAll}</option>
          <option value="chat">{ja.projectType.chat}</option>
          <option value="cowork">{ja.projectType.cowork}</option>
        </select>
        <select
          className="select"
          aria-label={ja.dashboard.sortLabel}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="updated">{ja.dashboard.sortUpdated}</option>
          <option value="created">{ja.dashboard.sortCreated}</option>
          <option value="name">{ja.dashboard.sortName}</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {ja.dashboard.showArchived}
        </label>
      </div>

      <Message message={message} />

      {projects === null ? (
        <p className="muted">{ja.common.loading}</p>
      ) : visible.length === 0 ? (
        <p className="empty">{projects.length === 0 ? ja.dashboard.empty : ja.dashboard.noMatch}</p>
      ) : (
        <ul className="cards" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {visible.map((p) => (
            <li key={p.id} className={`card type-${p.type}${p.archived ? ' archived' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <TypeBadge type={p.type} />
                <span className="row" style={{ gap: '0.4rem' }}>
                  {p.pinned && <span className="pin">★ {ja.dashboard.pinned}</span>}
                  {p.archived && <span className="card-meta">{ja.dashboard.archived}</span>}
                </span>
              </div>
              <h2 className="card-title">{p.name}</h2>
              <span className="card-meta">{ja.dashboard.updatedAt(formatDate(p.updated_at))}</span>
              {p.type === 'cowork' && <span className="card-path">{p.work_folder}</span>}
              <div className="card-actions">
                <button
                  className="btn btn-sm btn-primary"
                  type="button"
                  onClick={() => onOpen(p)}
                  disabled={!apiKeyConfigured}
                  title={apiKeyConfigured ? undefined : ja.dashboard.keyRequired}
                >
                  {ja.dashboard.open}
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => setDialog({ kind: 'edit', project: p })}
                >
                  {ja.dashboard.edit}
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => setDialog({ kind: 'duplicate', project: p })}
                >
                  {ja.dashboard.duplicate}
                </button>
                <button className="btn btn-sm" type="button" onClick={() => void exportProject(p)}>
                  {ja.exchange.exportProject}
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  title={ja.templates.saveNote}
                  onClick={() => setTemplating({ project: p, name: p.name })}
                >
                  {ja.templates.saveButton}
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() =>
                    void run(() =>
                      unwrap(window.lumina.projects.update(p.id, { pinned: !p.pinned }))
                    )
                  }
                >
                  {p.pinned ? ja.dashboard.unpin : ja.dashboard.pin}
                </button>
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() =>
                    void run(() =>
                      unwrap(window.lumina.projects.update(p.id, { archived: !p.archived }))
                    )
                  }
                >
                  {p.archived ? ja.dashboard.unarchive : ja.dashboard.archive}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => setDeleting(p)}
                >
                  {ja.dashboard.delete}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {templating && (
        <Dialog
          title={ja.templates.saveTitle}
          onClose={() => setTemplating(null)}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setTemplating(null)}>
                {ja.common.cancel}
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={templating.name.trim() === ''}
                onClick={() => void saveTemplate()}
              >
                {ja.common.save}
              </button>
            </>
          }
        >
          <p className="hint">{ja.templates.saveNote}</p>
          <div className="field">
            <label htmlFor="template-name">{ja.templates.name}</label>
            <input
              id="template-name"
              className="input"
              autoFocus
              maxLength={100}
              value={templating.name}
              onChange={(e) => setTemplating({ ...templating, name: e.target.value })}
            />
          </div>
        </Dialog>
      )}

      {dialog && (
        <ProjectDialog
          mode={dialog}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null)
            void reload()
          }}
        />
      )}

      {importing && (
        <ImportDialog
          preview={importing}
          onCancel={() => setImporting(null)}
          onDone={(project) => {
            setImporting(null)
            setMessage({ tone: 'info', text: ja.exchange.imported(project.name) })
            void reload()
          }}
        />
      )}

      {/* DSH-10: 削除は確認を経る。作業フォルダ内のファイルは消さない */}
      {deleting && (
        <ConfirmDialog
          danger
          title={ja.dashboard.deleteTitle}
          confirmLabel={ja.dashboard.delete}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting
            setDeleting(null)
            void run(() => unwrap(window.lumina.projects.delete(target.id)))
          }}
          message={
            <>
              <p>{ja.dashboard.deleteMessage(deleting.name)}</p>
              {deleting.type === 'cowork' && (
                <p className="hint">
                  {ja.dashboard.deleteCoworkNote}
                  <br />
                  <span className="mono">{deleting.work_folder}</span>
                </p>
              )}
            </>
          }
        />
      )}
    </main>
  )
}
