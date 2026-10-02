import { useState } from 'react'
import type {
  FileChange,
  FileDiff,
  PermissionRequest,
  PermissionResponse,
  TodoItem,
  ToolEventInfo
} from '@shared/types'
import { diffLines } from '../lib/diff'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'
import { ConfirmDialog, Dialog } from './Dialog'

const formatSize = (bytes: number | null): string =>
  bytes === null
    ? '-'
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
      : `${Math.ceil(bytes / 1024)}KB`

const shortTool = (name: string): string => name.replace(/^mcp__lumina__/, '')

/**
 * ツール実行の一覧（COW-05: ターミナル風に、実行中から結果までをリアルタイムに表示する）
 */
export function ToolEventList({ events }: { events: ToolEventInfo[] }): React.JSX.Element | null {
  if (events.length === 0) return null
  return (
    <details className="tool-log" open>
      <summary>
        {ja.cowork.tools}（{events.length}）
      </summary>
      <ol>
        {events.map((e) => {
          const denied = e.permission_method === 'denied'
          const running = !denied && e.finished_at === null
          const failed = !denied && e.result?.startsWith('エラー')
          return (
            <li
              key={e.id}
              className={`tool-line${denied ? ' denied' : failed ? ' failed' : running ? ' running' : ''}`}
            >
              <span className="tool-name">{shortTool(e.tool_name)}</span>
              <span className="tool-target">{e.command ? `$ ${e.command}` : (e.target ?? '')}</span>
              <span className="tool-method">
                {running ? ja.cowork.running : ja.cowork.method[e.permission_method]}
              </span>
              {e.result && (denied || failed) && <div className="tool-result">{e.result}</div>}
            </li>
          )
        })}
      </ol>
    </details>
  )
}

/**
 * 確認ダイアログ（6.7、SEC-12: 対象の一覧を示す。削除・コマンド・専用確認は警告の見た目にする）
 */
export function PermissionDialog({
  request,
  onRespond
}: {
  request: PermissionRequest
  onRespond: (response: PermissionResponse) => void
}): React.JSX.Element {
  const category = ja.cowork.category[request.category]
  const danger = request.category !== 'write' || request.danger !== null
  return (
    <Dialog
      title={ja.cowork.permissionTitle(category)}
      danger={danger}
      onClose={() => onRespond('deny')}
      footer={
        <>
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => onRespond('deny')}
            autoFocus
          >
            {ja.cowork.deny}
          </button>
          {request.offerAlways && (
            <>
              <button className="btn" type="button" onClick={() => onRespond('project')}>
                {ja.cowork.allowProject}
              </button>
              <button className="btn" type="button" onClick={() => onRespond('thread')}>
                {ja.cowork.allowThread}
              </button>
            </>
          )}
          <button className="btn btn-primary" type="button" onClick={() => onRespond('once')}>
            {ja.cowork.allowOnce}
          </button>
        </>
      }
    >
      <p>{ja.cowork.permissionLead(shortTool(request.toolName))}</p>
      {request.danger && (
        <p className="message message-error">{ja.cowork.dangerNote(request.danger)}</p>
      )}
      {request.category === 'delete' && !request.offerAlways && !request.danger && (
        <p className="message message-info">{ja.cowork.bulkNote}</p>
      )}
      {request.targets.length > 0 && (
        <>
          <p className="hint">{ja.cowork.targets(request.targets.length)}</p>
          <table className="target-table">
            <tbody>
              {request.targets.map((t) => (
                <tr key={t.path}>
                  <td className="mono">{t.path}</td>
                  <td>{ja.cowork.kind[t.kind]}</td>
                  <td className="mono">{formatSize(t.size_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {request.command !== null && (
        <>
          <p className="hint">{ja.cowork.command}</p>
          <pre className="command-preview">{request.command}</pre>
          <p className="hint">{ja.cowork.commandNote}</p>
        </>
      )}
      {request.detail && (
        <>
          <p className="hint">{ja.cowork.detail}</p>
          <pre className="detail-preview">{request.detail}</pre>
        </>
      )}
    </Dialog>
  )
}

/**
 * 実行単位の変更の一覧と一括 Undo（SEC-15、SEC-16）
 */
export function ChangesPanel({
  messageId,
  disabled
}: {
  messageId: string
  disabled: boolean
}): React.JSX.Element {
  const [changes, setChanges] = useState<FileChange[] | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      setChanges(await unwrap(window.lumina.cowork.changes(messageId)))
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  const undo = async (): Promise<void> => {
    setConfirming(false)
    try {
      const result = await unwrap(window.lumina.cowork.undo(messageId))
      const parts = [ja.cowork.undoDone(result.restored.length)]
      if (result.skipped.length > 0) {
        parts.push(
          ja.cowork.undoSkipped(result.skipped.map((s) => `${s.path}（${s.reason}）`).join('、'))
        )
      }
      setMessage(parts.join(' '))
      await load()
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  const showDiff = async (snapshotId: string): Promise<void> => {
    try {
      setDiff(await unwrap(window.lumina.cowork.diff(snapshotId)))
    } catch (e) {
      setMessage((e as Error).message)
    }
  }

  if (changes === null) {
    return (
      <button className="btn btn-sm" type="button" onClick={() => void load()}>
        {ja.cowork.changes}
      </button>
    )
  }

  const pending = changes.filter((c) => !c.restored)
  return (
    <div className="changes">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>
          {ja.cowork.changes}（{changes.length}）
        </strong>
        <button className="btn btn-sm" type="button" onClick={() => setChanges(null)}>
          {ja.cowork.hideChanges}
        </button>
      </div>
      <ul>
        {changes.map((c) => (
          <li key={c.snapshotId} className="row">
            <span className={`change-kind change-${c.kind}`}>{ja.cowork.changeKind[c.kind]}</span>
            <span className="mono">{c.path}</span>
            {c.restored && <span className="hint">{ja.cowork.restored}</span>}
            {c.kind !== 'trashed' && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void showDiff(c.snapshotId)}
              >
                {ja.cowork.showDiff}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="hint">{ja.cowork.bashNote}</p>
      {pending.length > 0 && (
        <button
          className="btn btn-sm btn-danger"
          type="button"
          disabled={disabled}
          onClick={() => setConfirming(true)}
        >
          {ja.cowork.undo}
        </button>
      )}
      {message && <p className="hint">{message}</p>}

      {confirming && (
        <ConfirmDialog
          danger
          title={ja.cowork.undoTitle}
          confirmLabel={ja.cowork.undo}
          message={
            <>
              <p>{ja.cowork.undoMessage}</p>
              <ul>
                {pending.map((c) => (
                  <li key={c.snapshotId} className="mono">
                    {ja.cowork.changeKind[c.kind]}: {c.path}
                  </li>
                ))}
              </ul>
              <p className="hint">{ja.cowork.bashNote}</p>
            </>
          }
          onCancel={() => setConfirming(false)}
          onConfirm={() => void undo()}
        />
      )}
      {diff && <DiffDialog diff={diff} onClose={() => setDiff(null)} />}
    </div>
  )
}

function DiffDialog({ diff, onClose }: { diff: FileDiff; onClose: () => void }): React.JSX.Element {
  const lines = diff.binary ? null : diffLines(diff.before ?? '', diff.after ?? '')
  return (
    <Dialog
      title={ja.cowork.diffTitle(diff.path)}
      onClose={onClose}
      footer={
        <button className="btn" type="button" onClick={onClose}>
          {ja.common.back}
        </button>
      }
    >
      {lines === null ? (
        <p className="hint">{ja.cowork.binary}</p>
      ) : lines.every((l) => l.type === 'same') ? (
        <p className="hint">{ja.cowork.noDiff}</p>
      ) : (
        <pre className="diff">
          {lines.map((l, i) => (
            <div key={i} className={`diff-${l.type}`}>
              {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </Dialog>
  )
}

/**
 * todo の進捗（COW-13）
 */
export function TodoPanel({ todos }: { todos: TodoItem[] }): React.JSX.Element | null {
  if (todos.length === 0) return null
  return (
    <aside className="todo-panel" aria-label={ja.cowork.todos}>
      <strong>{ja.cowork.todos}</strong>
      <ul>
        {todos.map((t, i) => (
          <li key={i} className={`todo-${t.status}`}>
            <span className="todo-mark" aria-hidden="true">
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'}
            </span>
            <span>{t.status === 'in_progress' ? t.activeForm : t.content}</span>
            <span className="visually-hidden">（{ja.cowork.todoStatus[t.status]}）</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
