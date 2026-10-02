import { useEffect, useState } from 'react'
import type { Project, ProjectType, SearchHit } from '@shared/types'
import { Message, type MessageState } from '../components/Message'
import { TypeBadge } from '../components/TypeBadge'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

const LIMIT = 100

const formatTime = (epoch: number): string =>
  new Date(epoch).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })

/** 抜粋の [一致箇所] を強調表示する */
function Snippet({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(\[[^\]]*\])/g)
  return (
    <span>
      {parts.map((part, i) =>
        part.startsWith('[') && part.endsWith(']') ? <mark key={i}>{part.slice(1, -1)}</mark> : part
      )}
    </span>
  )
}

/**
 * 横断検索（要件 SRC-01、SRC-02、DSH-09）。結果からスレッドの該当メッセージへ移動できる
 */
export function SearchScreen({ onOpen }: { onOpen: (hit: SearchHit) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projectType, setProjectType] = useState<ProjectType | ''>('')
  const [projects, setProjects] = useState<Project[]>([])
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.projects.list({ includeArchived: true }))
      .then((list) => active && setProjects(list))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const run = async (): Promise<void> => {
    if (!text.trim()) return
    setMessage(null)
    try {
      setHits(
        await unwrap(
          window.lumina.search.query({
            text,
            ...(projectId ? { projectId } : {}),
            ...(projectType ? { projectType } : {})
          })
        )
      )
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  return (
    <main className="screen" style={{ maxWidth: '64rem' }}>
      <h1 className="screen-title">{ja.search.title}</h1>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <input
          className="input"
          type="search"
          autoFocus
          placeholder={ja.search.placeholder}
          aria-label={ja.search.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          className="select"
          aria-label={ja.logs.project}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">{ja.search.allProjects}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label={ja.projectDialog.type}
          value={projectType}
          onChange={(e) => setProjectType(e.target.value as ProjectType | '')}
        >
          <option value="">{ja.search.allTypes}</option>
          <option value="chat">{ja.projectType.chat}</option>
          <option value="cowork">{ja.projectType.cowork}</option>
        </select>
        <button className="btn btn-primary" type="submit">
          {ja.search.run}
        </button>
      </form>
      <Message message={message} />

      {hits !== null &&
        (hits.length === 0 ? (
          <p className="empty">{ja.search.none}</p>
        ) : (
          <>
            {hits.length >= LIMIT && <p className="hint">{ja.search.limit(LIMIT)}</p>}
            <ul className="search-results">
              {hits.map((h) => (
                <li key={`${h.kind}-${h.message_id}-${h.snippet}`}>
                  <button className="search-hit" type="button" onClick={() => onOpen(h)}>
                    <span className="row" style={{ gap: '0.5rem' }}>
                      <TypeBadge type={h.project_type} />
                      <strong>{h.project_name}</strong>
                      <span className="muted">／ {h.thread_title ?? ja.project.untitled}</span>
                      <span className="hint">
                        {h.role === 'user' ? ja.chat.user : ja.chat.assistant}・
                        {formatTime(h.created_at)}
                      </span>
                    </span>
                    <span className="search-snippet">
                      {h.kind === 'attachment' ? (
                        <>
                          {ja.search.attachment}: <span className="mono">{h.snippet}</span>
                        </>
                      ) : (
                        <Snippet text={h.snippet} />
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ))}
    </main>
  )
}
