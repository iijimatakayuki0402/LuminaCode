import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activePath } from '@shared/conversation'
import type {
  AttachmentInfo,
  ChatPrefs,
  Message,
  PermissionRequest,
  PermissionResponse,
  StageResult,
  TodoItem,
  ToolEventInfo
} from '@shared/types'
import { CopyButton } from '../components/CopyButton'
import { ChangesPanel, PermissionDialog, TodoPanel, ToolEventList } from '../components/CoworkParts'
import { Dialog } from '../components/Dialog'
import { Markdown } from '../components/Markdown'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'

interface Live {
  text: string
  thinking: string
  retry: string | null
}

const formatTime = (epoch: number): string =>
  new Date(epoch).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'medium' })

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

/**
 * 通常チャット（要件 6.4）と Cowork（要件 6.5）の会話画面
 */
export function ChatView({
  threadId,
  cowork = false,
  onThreadChanged
}: {
  threadId: string
  /** Cowork のスレッド（ツール実行・確認ダイアログ・変更の取り消しを表示する） */
  cowork?: boolean
  /** タイトルの自動設定などでスレッド一覧の再読み込みが必要になったとき */
  onThreadChanged: () => void
}): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([])
  const [tools, setTools] = useState<ToolEventInfo[]>([])
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [resendConfirm, setResendConfirm] = useState<{
    run: () => Promise<boolean>
    previousRunId: string | null
    resolve: (ok: boolean) => void
  } | null>(null)
  const [live, setLive] = useState<Record<string, Live>>({})
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<ChatPrefs>({ sendKey: 'enter' })
  const online = useOnline()
  const logRef = useRef<HTMLDivElement>(null)
  // 通知の購読の中から最新の関数を呼べるようにする
  const onThreadChangedRef = useRef(onThreadChanged)
  useEffect(() => {
    onThreadChangedRef.current = onThreadChanged
  }, [onThreadChanged])
  const stickToBottom = useRef(true)

  // スレッドの読み込みと、生成中の通知の購読
  useEffect(() => {
    let active = true
    Promise.all([
      unwrap(window.lumina.messages.listByThread(threadId)),
      unwrap(window.lumina.chatPrefs.get()),
      cowork ? unwrap(window.lumina.cowork.toolEvents(threadId)) : Promise.resolve([])
    ])
      .then(([list, p, events]) => {
        if (!active) return
        setMessages(list)
        setPrefs(p)
        setTools(events)
        setLive({})
        setPermissions([])
        setTodos([])
        stickToBottom.current = true
      })
      .catch((e: unknown) => active && setError((e as Error).message))

    const off = window.lumina.chat.onEvent((event) => {
      if (event.threadId !== threadId) return
      if (event.type === 'finished') {
        setMessages((list) => list.map((m) => (m.id === event.message.id ? event.message : m)))
        setLive((map) => {
          const next = { ...map }
          delete next[event.message.id]
          return next
        })
        // 停止した実行の確認待ちは main 側で拒否済み
        setPermissions([])
        // 使用量の累計・上限の警告、Cowork の「常に許可」の表示を更新する
        onThreadChangedRef.current()
        if (event.errorMessage) setError(event.errorMessage)
        return
      }
      if (event.type === 'tool') {
        setTools((list) => {
          const index = list.findIndex((t) => t.id === event.event.id)
          if (index === -1) return [...list, event.event]
          const next = [...list]
          next[index] = event.event
          return next
        })
        return
      }
      if (event.type === 'permission') {
        setPermissions((list) => [...list, event.request])
        return
      }
      if (event.type === 'todos') {
        setTodos(event.todos)
        return
      }
      setLive((map) => {
        const current = map[event.messageId] ?? { text: '', thinking: '', retry: null }
        const next =
          event.type === 'text'
            ? { ...current, text: current.text + event.text, retry: null }
            : event.type === 'thinking'
              ? { ...current, thinking: current.thinking + event.text, retry: null }
              : {
                  ...current,
                  retry: ja.chat.retrying(
                    event.attempt,
                    event.maxAttempts,
                    Math.round(event.waitMs / 1000)
                  )
                }
        return { ...map, [event.messageId]: next }
      })
    })
    return () => {
      active = false
      off()
    }
  }, [threadId, cowork])

  const path = useMemo(() => activePath(messages), [messages])
  const generating = path.some((m) => m.status === 'streaming')
  const latestUserId = [...path].reverse().find((m) => m.role === 'user')?.id ?? null
  const last = path.at(-1)

  // 末尾付近を見ているときだけ自動でスクロールする
  useEffect(() => {
    const el = logRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [path, live])

  const addMessages = (...added: Message[]): void => {
    setMessages((list) => [...list, ...added])
    stickToBottom.current = true
  }

  const fail = (e: unknown): void => setError((e as Error).message)

  const send = async (content: string, attachments: AttachmentInfo[]): Promise<boolean> => {
    setError(null)
    try {
      const result = await unwrap(
        window.lumina.chat.send({ threadId, content, attachmentIds: attachments.map((a) => a.id) })
      )
      addMessages(result.userMessage, result.assistantMessage)
      if (path.length === 0) onThreadChanged()
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  const stop = useCallback(() => void window.lumina.chat.stop(threadId), [threadId])

  // Esc で生成を停止する（ショートカット）
  useEffect(() => {
    if (!generating) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [generating, stop])

  const regenerate = async (userMessageId: string): Promise<void> => {
    setError(null)
    try {
      addMessages(await unwrap(window.lumina.chat.regenerate(userMessageId)))
    } catch (e) {
      fail(e)
    }
  }

  const respond = (request: PermissionRequest, response: PermissionResponse): void => {
    setPermissions((list) => list.filter((r) => r.requestId !== request.requestId))
    void window.lumina.cowork.respond(request.requestId, response).then((r) => {
      if (!r.ok) setError(r.error.message)
    })
  }

  const resend = async (
    message: Message,
    content: string,
    keep: AttachmentInfo[],
    added: AttachmentInfo[]
  ): Promise<boolean> => {
    setError(null)
    // CHT-14（Cowork）: 前回の変更は自動では戻らないため、再送信の前に確認する
    if (cowork) {
      const previousRunId = path.find((m) => m.parent_id === message.id)?.id ?? null
      return new Promise<boolean>((resolve) =>
        setResendConfirm({
          previousRunId,
          resolve,
          run: () => doResend(message, content, keep, added)
        })
      )
    }
    return doResend(message, content, keep, added)
  }

  const doResend = async (
    message: Message,
    content: string,
    keep: AttachmentInfo[],
    added: AttachmentInfo[]
  ): Promise<boolean> => {
    try {
      const result = await unwrap(
        window.lumina.chat.editAndResend({
          userMessageId: message.id,
          content,
          keepAttachmentIds: keep.map((a) => a.id),
          attachmentIds: added.map((a) => a.id)
        })
      )
      addMessages(result.userMessage, result.assistantMessage)
      return true
    } catch (e) {
      fail(e)
      return false
    }
  }

  return (
    <div className="chat">
      <div
        className="chat-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        role="log"
        aria-live="polite"
      >
        {path.length === 0 && <p className="empty">{ja.chat.empty}</p>}
        {path.map((m) =>
          m.role === 'user' ? (
            <UserRow
              key={m.id}
              message={m}
              editable={m.id === latestUserId && !generating}
              allowAttachments={!cowork}
              onResend={(content, keep, added) => resend(m, content, keep, added)}
              onError={fail}
            />
          ) : (
            <AssistantRow
              key={m.id}
              message={m}
              live={live[m.id]}
              cowork={cowork}
              tools={cowork ? tools.filter((t) => t.message_id === m.id) : []}
              generating={generating}
            />
          )
        )}
        {last?.role === 'assistant' &&
          ['error', 'stopped', 'interrupted'].includes(last.status) &&
          latestUserId && (
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void regenerate(latestUserId)}
              >
                {ja.chat.regenerate}
              </button>
            </div>
          )}
      </div>

      {error && (
        <p className="message message-error" role="alert">
          {error}
        </p>
      )}
      {!online && <p className="message message-info">{ja.chat.offline}</p>}

      {cowork && <TodoPanel todos={todos} />}

      <Composer
        sendKey={prefs.sendKey}
        generating={generating}
        disabled={!online}
        allowAttachments={!cowork}
        onSend={send}
        onStop={stop}
        onError={fail}
      />

      {permissions[0] && (
        <PermissionDialog
          key={permissions[0].requestId}
          request={permissions[0]}
          onRespond={(response) => respond(permissions[0], response)}
        />
      )}

      {resendConfirm && (
        <Dialog
          title={ja.cowork.resendTitle}
          danger
          onClose={() => {
            resendConfirm.resolve(false)
            setResendConfirm(null)
          }}
          footer={
            <>
              <button
                className="btn"
                type="button"
                autoFocus
                onClick={() => {
                  resendConfirm.resolve(false)
                  setResendConfirm(null)
                }}
              >
                {ja.common.cancel}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const current = resendConfirm
                  setResendConfirm(null)
                  void current.run().then(current.resolve)
                }}
              >
                {ja.cowork.resendKeep}
              </button>
              {resendConfirm.previousRunId && (
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => {
                    const current = resendConfirm
                    setResendConfirm(null)
                    void unwrap(window.lumina.cowork.undo(current.previousRunId!))
                      .then(() => current.run())
                      .then(current.resolve)
                      .catch((e: unknown) => {
                        fail(e)
                        current.resolve(false)
                      })
                  }}
                >
                  {ja.cowork.resendUndo}
                </button>
              )}
            </>
          }
        >
          <p>{ja.cowork.resendMessage}</p>
          <p className="hint">{ja.cowork.bashNote}</p>
        </Dialog>
      )}
    </div>
  )
}

// ========================================
// メッセージ行（DSN-01: 吹き出しではなく、ロール名と時刻を付けたログ行）
// ========================================

function UserRow({
  message,
  editable,
  allowAttachments,
  onResend,
  onError
}: {
  message: Message
  editable: boolean
  allowAttachments: boolean
  onResend: (content: string, keep: AttachmentInfo[], added: AttachmentInfo[]) => Promise<boolean>
  onError: (e: unknown) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [keep, setKeep] = useState<AttachmentInfo[]>([])
  const staging = useStaging(onError)

  const startEdit = (): void => {
    setDraft(message.content)
    setKeep(message.attachments)
    setEditing(true)
  }

  const cancel = (): void => {
    staging.clear()
    setEditing(false)
  }

  const submit = async (): Promise<void> => {
    if (await onResend(draft, keep, staging.items)) {
      staging.reset()
      setEditing(false)
    }
  }

  return (
    <article className="log-row log-user">
      <header className="log-head">
        <span className="log-role">{ja.chat.user}</span>
        <time>{formatTime(message.created_at)}</time>
      </header>
      {editing ? (
        <div className="log-body">
          <textarea
            className="input textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={ja.chat.edit}
            autoFocus
          />
          <AttachmentChips
            items={[...keep, ...staging.items]}
            onRemove={(a) =>
              keep.some((k) => k.id === a.id)
                ? setKeep(keep.filter((k) => k.id !== a.id))
                : staging.remove(a)
            }
          />
          <div className="row">
            {allowAttachments && (
              <button className="btn btn-sm" type="button" onClick={() => void staging.select()}>
                📎 {ja.chat.attach}
              </button>
            )}
            <button className="btn btn-sm btn-primary" type="button" onClick={() => void submit()}>
              {ja.chat.resend}
            </button>
            <button className="btn btn-sm" type="button" onClick={cancel}>
              {ja.common.cancel}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="log-body user-text">{message.content}</div>
          <AttachmentChips items={message.attachments} />
          <div className="log-actions">
            <CopyButton text={message.content} />
            {editable && (
              <button className="btn btn-sm" type="button" onClick={startEdit}>
                {ja.chat.edit}
              </button>
            )}
          </div>
        </>
      )}
    </article>
  )
}

function AssistantRow({
  message,
  live,
  cowork,
  tools,
  generating
}: {
  message: Message
  live?: Live
  cowork: boolean
  tools: ToolEventInfo[]
  generating: boolean
}): React.JSX.Element {
  const streaming = message.status === 'streaming'
  const text = streaming ? (live?.text ?? '') : message.content
  const thinking = streaming ? (live?.thinking ?? '') : (message.thinking ?? '')

  return (
    <article className="log-row log-assistant" aria-busy={streaming}>
      <header className="log-head">
        <span className="log-role">{ja.chat.assistant}</span>
        <time>{formatTime(message.created_at)}</time>
        {message.model && <span className="mono muted">{message.model}</span>}
        {message.tokens_used !== null && (
          <span className="mono muted">{ja.chat.tokens(message.tokens_used)}</span>
        )}
        {message.estimated_cost !== null && (
          <span className="mono muted">{ja.chat.cost(message.estimated_cost)}</span>
        )}
      </header>
      {thinking && (
        <details className="thinking">
          <summary>{streaming && !text ? ja.chat.thinkingNow : ja.chat.thinking}</summary>
          <div className="thinking-body">{thinking}</div>
        </details>
      )}
      <ToolEventList events={tools} />
      <div className="log-body">
        {text ? (
          <Markdown text={text} />
        ) : (
          streaming && <span className="muted">{ja.chat.streaming}</span>
        )}
        {streaming && <span className="cursor" aria-hidden="true" />}
      </div>
      {live?.retry && <p className="message message-info">{live.retry}</p>}
      {message.status === 'stopped' && <p className="hint">{ja.chat.status.stopped}</p>}
      {message.status === 'interrupted' && <p className="hint">{ja.chat.status.interrupted}</p>}
      {message.status === 'error' && <p className="hint">{ja.chat.status.error}</p>}
      {message.stop_reason === 'refusal' && <p className="hint">{ja.chat.refusal}</p>}
      {message.stop_reason === 'max_tokens' && <p className="hint">{ja.chat.maxTokens}</p>}
      {/* CHT-13: 回答の下にコピーボタンを常時表示する（生成中は無効） */}
      <div className="log-actions">
        <CopyButton text={message.content} disabled={streaming || message.content === ''} />
        {cowork && !streaming && tools.length > 0 && (
          <ChangesPanel messageId={message.id} disabled={generating} />
        )}
      </div>
    </article>
  )
}

// ========================================
// 入力欄と添付ファイル（CHT-09、ATT-03、ATT-05）
// ========================================

function useStaging(onError: (e: unknown) => void): {
  items: AttachmentInfo[]
  select: () => Promise<void>
  addPaths: (paths: string[]) => Promise<void>
  addData: (name: string, data: Uint8Array) => Promise<void>
  remove: (item: AttachmentInfo) => void
  clear: () => void
  reset: () => void
} {
  const [items, setItems] = useState<AttachmentInfo[]>([])

  const apply = (result: StageResult): void => {
    setItems((list) => [...list, ...result.staged])
    if (result.errors.length > 0) onError(new Error(result.errors.join('\n')))
  }
  const run = async (task: () => Promise<StageResult>): Promise<void> => {
    try {
      apply(await task())
    } catch (e) {
      onError(e)
    }
  }

  return {
    items,
    select: () => run(() => unwrap(window.lumina.attachments.select())),
    addPaths: (paths) => run(() => unwrap(window.lumina.attachments.stagePaths(paths))),
    addData: (name, data) => run(() => unwrap(window.lumina.attachments.stageData(name, data))),
    remove: (item) => {
      void window.lumina.attachments.discard(item.id)
      setItems((list) => list.filter((a) => a.id !== item.id))
    },
    clear: () => {
      for (const item of items) void window.lumina.attachments.discard(item.id)
      setItems([])
    },
    // 送信済み（main 側でメッセージに移動済み）なので、取り消しはせず一覧だけ空にする
    reset: () => setItems([])
  }
}

function AttachmentChips({
  items,
  onRemove
}: {
  items: AttachmentInfo[]
  onRemove?: (item: AttachmentInfo) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul className="chips">
      {items.map((a) => (
        <li key={a.id} className="chip">
          {a.preview ? (
            <img src={a.preview} alt="" className="chip-thumb" />
          ) : (
            <span className="chip-kind mono">{a.kind.toUpperCase()}</span>
          )}
          <span className="chip-name">{a.filename}</span>
          <span className="muted">{formatSize(a.size_bytes)}</span>
          {onRemove && (
            <button
              className="btn btn-sm"
              type="button"
              aria-label={ja.chat.removeAttachment(a.filename)}
              onClick={() => onRemove(a)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function Composer({
  sendKey,
  generating,
  disabled,
  allowAttachments,
  onSend,
  onStop,
  onError
}: {
  sendKey: ChatPrefs['sendKey']
  generating: boolean
  disabled: boolean
  allowAttachments: boolean
  onSend: (content: string, attachments: AttachmentInfo[]) => Promise<boolean>
  onStop: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const staging = useStaging(onError)

  const canSend =
    !generating && !disabled && !sending && (text.trim() !== '' || staging.items.length > 0)

  const submit = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    if (await onSend(text, staging.items)) {
      setText('')
      staging.reset()
    }
    setSending(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const wantsSend = sendKey === 'enter' ? !e.shiftKey && !e.ctrlKey : e.ctrlKey
    if (wantsSend) {
      e.preventDefault()
      void submit()
    }
  }

  // ATT-03: クリップボードの画像の貼り付け
  const onPaste = (e: React.ClipboardEvent): void => {
    if (!allowAttachments) return
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      const ext = file.type.split('/')[1] ?? 'png'
      void file
        .arrayBuffer()
        .then((buf) => staging.addData(file.name || `pasted.${ext}`, new Uint8Array(buf)))
    }
  }

  // ATT-03: ドラッグ＆ドロップ
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    if (!allowAttachments) {
      onError(new Error(ja.cowork.noAttachments))
      return
    }
    const paths = [...e.dataTransfer.files]
      .map((f) => window.lumina.attachments.pathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) void staging.addPaths(paths)
  }

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-hint">{ja.chat.dropHere}</div>}
      <AttachmentChips items={staging.items} onRemove={staging.remove} />
      <textarea
        className="input textarea composer-input"
        value={text}
        placeholder={ja.chat.placeholder(sendKey)}
        aria-label={ja.chat.placeholder(sendKey)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {allowAttachments ? (
          <button className="btn btn-sm" type="button" onClick={() => void staging.select()}>
            📎 {ja.chat.attach}
          </button>
        ) : (
          <span />
        )}
        {generating ? (
          <button className="btn btn-danger" type="button" onClick={onStop}>
            ■ {ja.chat.stop}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
          >
            {ja.chat.send}
          </button>
        )}
      </div>
    </div>
  )
}
