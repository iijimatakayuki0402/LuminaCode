import { useEffect, useState } from 'react'
import type { Project, ToolCategory, ToolEventFilter, ToolEventRow } from '@shared/types'
import { ConfirmDialog } from '../components/Dialog'
import { Message, type MessageState } from '../components/Message'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

const CATEGORIES: ToolCategory[] = ['read', 'write', 'delete', 'command', 'plan', 'web', 'other']
const LIMIT = 1000
const RETENTION_DAYS = 90

const formatTime = (epoch: number): string =>
  new Date(epoch).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' })

/** 日付（YYYY-MM-DD）を、その日の 0 時 / 23:59:59.999 の epoch にする */
const dayStart = (value: string): number | undefined =>
  value ? new Date(`${value}T00:00:00`).getTime() : undefined
const dayEnd = (value: string): number | undefined =>
  value ? new Date(`${value}T23:59:59.999`).getTime() : undefined

/**
 * 操作ログの画面（要件 LOG-02: 日時・種別・対象で絞り込み、閲覧・書き出し。LOG-03: 削除）
 */
export function OperationLogScreen(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [category, setCategory] = useState<ToolCategory | ''>('')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState<ToolEventRow[] | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const filter = (): ToolEventFilter => ({
    ...(projectId ? { projectId } : {}),
    ...(category ? { category } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(from ? { from: dayStart(from) } : {}),
    ...(to ? { to: dayEnd(to) } : {}),
    limit: LIMIT
  })

  useEffect(() => {
    let active = true
    Promise.all([
      unwrap(window.lumina.projects.list({ includeArchived: true })),
      unwrap(window.lumina.logs.search({ limit: LIMIT }))
    ])
      .then(([list, logs]) => {
        if (!active) return
        setProjects(list.filter((p) => p.type === 'cowork'))
        setRows(logs)
      })
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  const search = async (): Promise<void> => {
    setMessage(null)
    try {
      setRows(await unwrap(window.lumina.logs.search(filter())))
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  const exportLogs = async (format: 'csv' | 'json'): Promise<void> => {
    try {
      const path = await unwrap(window.lumina.logs.export(filter(), format))
      if (path) setMessage({ tone: 'info', text: ja.logs.exported(path) })
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  const deleteOld = async (): Promise<void> => {
    setConfirmDelete(false)
    const before = dayStart(to)
    if (before === undefined) return
    try {
      const count = await unwrap(window.lumina.logs.deleteBefore(before))
      setMessage({ tone: 'info', text: ja.logs.deleted(count) })
      await search()
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  return (
    <main className="screen" style={{ maxWidth: '80rem' }}>
      <h1 className="screen-title">{ja.logs.title}</h1>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <select
          className="select"
          aria-label={ja.logs.project}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">{ja.logs.allProjects}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label={ja.logs.category}
          value={category}
          onChange={(e) => setCategory(e.target.value as ToolCategory | '')}
        >
          <option value="">{ja.logs.allCategories}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {ja.cowork.category[c]}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="search"
          placeholder={ja.logs.query}
          aria-label={ja.logs.query}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          {ja.logs.from}
          <input
            className="input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="check">
          {ja.logs.to}
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn btn-primary" type="submit">
          {ja.logs.search}
        </button>
      </form>

      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <button className="btn btn-sm" type="button" onClick={() => void exportLogs('csv')}>
          {ja.logs.exportCsv}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => void exportLogs('json')}>
          {ja.logs.exportJson}
        </button>
        <button
          className="btn btn-sm btn-danger"
          type="button"
          onClick={() =>
            to ? setConfirmDelete(true) : setMessage({ tone: 'info', text: ja.logs.needTo })
          }
        >
          {ja.logs.deleteOld}
        </button>
        <span className="hint">{ja.logs.retention(RETENTION_DAYS)}</span>
      </div>

      <Message message={message} />

      {rows === null ? (
        <p className="muted">{ja.common.loading}</p>
      ) : rows.length === 0 ? (
        <p className="empty">{ja.logs.empty}</p>
      ) : (
        <>
          <p className="hint">
            {ja.logs.count(rows.length)} {rows.length >= LIMIT && ja.logs.limitNote(LIMIT)}
          </p>
          <div className="log-table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th>{ja.logs.columns.time}</th>
                  <th>{ja.logs.columns.project}</th>
                  <th>{ja.logs.columns.tool}</th>
                  <th>{ja.logs.columns.target}</th>
                  <th>{ja.logs.columns.method}</th>
                  <th>{ja.logs.columns.result}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.permission_method === 'denied' ? 'denied' : ''}>
                    <td className="mono">{formatTime(r.created_at)}</td>
                    <td>{r.project_name}</td>
                    <td>
                      {r.category ? ja.cowork.category[r.category] : ''}{' '}
                      <span className="mono muted">
                        {r.tool_name.replace(/^mcp__lumina__/, '')}
                      </span>
                    </td>
                    <td className="mono">{r.command ? `$ ${r.command}` : r.target}</td>
                    <td>{ja.cowork.method[r.permission_method]}</td>
                    <td className="mono log-result">{r.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirmDelete && (
        <ConfirmDialog
          danger
          title={ja.logs.deleteTitle}
          confirmLabel={ja.logs.deleteOld}
          message={<p>{ja.logs.deleteMessage(to)}</p>}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void deleteOld()}
        />
      )}
    </main>
  )
}
