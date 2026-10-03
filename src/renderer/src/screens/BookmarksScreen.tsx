import { useEffect, useState } from 'react'
import type { BookmarkRow, Project } from '@shared/types'
import { Message, type MessageState } from '../components/Message'
import { TypeBadge } from '../components/TypeBadge'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

const formatTime = (epoch: number): string =>
  new Date(epoch).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })

/**
 * ブックマークの一覧（要件 BMK-02、BMK-03）。選ぶとスレッドの該当メッセージへ移動する
 */
export function BookmarksScreen({
  onOpen
}: {
  onOpen: (bookmark: BookmarkRow) => void
}): React.JSX.Element {
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [list, setList] = useState<BookmarkRow[] | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.projects.list({ includeArchived: true }))
      .then((p) => active && setProjects(p))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    unwrap(window.lumina.bookmarks.list(projectId || undefined))
      .then((l) => active && setList(l))
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [projectId])

  const remove = async (b: BookmarkRow): Promise<void> => {
    try {
      await unwrap(window.lumina.messages.setBookmark(b.message_id, false))
      setList((l) => (l ?? []).filter((x) => x.message_id !== b.message_id))
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  return (
    <main className="screen" style={{ maxWidth: '64rem' }}>
      <h1 className="screen-title">{ja.bookmarks.title}</h1>
      <div className="toolbar">
        <select
          className="select"
          aria-label={ja.logs.project}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">{ja.bookmarks.allProjects}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <Message message={message} />

      {list === null ? (
        <p className="muted">{ja.common.loading}</p>
      ) : list.length === 0 ? (
        <p className="empty">{ja.bookmarks.none}</p>
      ) : (
        <ul className="search-results">
          {list.map((b) => (
            <li key={b.message_id} className="row" style={{ alignItems: 'stretch' }}>
              <button
                className="search-hit"
                type="button"
                style={{ flex: 1 }}
                onClick={() => onOpen(b)}
              >
                <span className="row" style={{ gap: '0.5rem' }}>
                  <TypeBadge type={b.project_type} />
                  <strong>{b.project_name}</strong>
                  <span className="muted">／ {b.thread_title ?? ja.project.untitled}</span>
                  <span className="hint">
                    {formatTime(b.created_at)}・
                    {ja.bookmarks.bookmarkedAt(formatTime(b.bookmarked_at))}
                  </span>
                </span>
                <span className="search-snippet">{b.excerpt}</span>
              </button>
              <button
                className="btn btn-sm"
                type="button"
                aria-label={`${ja.chat.bookmarkRemove}: ${b.excerpt.slice(0, 20)}`}
                onClick={() => void remove(b)}
              >
                {ja.bookmarks.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
