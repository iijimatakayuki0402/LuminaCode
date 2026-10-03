import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { expandCommand, parseCommandInput } from '@shared/commands'
import { activePath, siblingsOf } from '@shared/conversation'
import type {
  AttachmentInfo,
  ChatPrefs,
  ContextUsage,
  SlashCommand,
  Thread,
  Message,
  PermissionRequest,
  PermissionResponse,
  StageResult,
  TodoItem,
  ToolEventInfo
} from '@shared/types'
import { CopyButton } from '../components/CopyButton'
import { ChangesPanel, PermissionDialog, TodoPanel, ToolEventList } from '../components/CoworkParts'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Markdown } from '../components/Markdown'
import { unwrap } from '../lib/ipc'
import { useShortcuts } from '../lib/useShortcuts'
import { SnippetPicker } from '../components/Snippets'
import { ja } from '../locales/ja'

interface Live {
  text: string
  thinking: string
  retry: string | null
  /** CHT-11: 検索している語（本文が届いたら消す） */
  searching?: string | null
}

/** 会話の一覧に並べる行（10.1: 仮想スクロールで、画面に見えている行だけを描画する） */
type LogRow =
  | { kind: 'summary'; key: string }
  | { kind: 'message'; key: string; message: Message; first: boolean }
  | { kind: 'regenerate'; key: string; userMessageId: string }

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
  onThreadChanged,
  onCompacted,
  focusMessageId
}: {
  threadId: string
  /** 検索結果から開いたときに表示・強調するメッセージ（SRC-01） */
  focusMessageId?: string
  /** Cowork のスレッド（ツール実行・確認ダイアログ・変更の取り消しを表示する） */
  cowork?: boolean
  /** タイトルの自動設定などでスレッド一覧の再読み込みが必要になったとき */
  onThreadChanged: () => void
  /** 要約して新しいスレッドを作ったとき（CTX-02） */
  onCompacted?: (thread: Thread) => void
}): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([])
  /** 表示中の分岐の末端（CHT-06） */
  const [leafId, setLeafId] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [context, setContext] = useState<ContextUsage | null>(null)
  const [compacting, setCompacting] = useState<'confirm' | 'running' | null>(null)
  /** 6.6: 作業フォルダのスラッシュコマンド（Cowork） */
  const [commands, setCommands] = useState<SlashCommand[]>([])
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
      cowork ? unwrap(window.lumina.cowork.toolEvents(threadId)) : Promise.resolve([]),
      unwrap(window.lumina.threads.get(threadId)),
      unwrap(window.lumina.usage.context(threadId)),
      cowork ? unwrap(window.lumina.cowork.pendingPermissions(threadId)) : Promise.resolve([])
    ])
      .then(([list, p, events, thread, ctx, waiting]) => {
        if (!active) return
        if (cowork) {
          void unwrap(window.lumina.threads.get(threadId))
            .then((t) => unwrap(window.lumina.cowork.commands(t.project_id)))
            .then((c) => active && setCommands(c))
            .catch(() => undefined)
        }
        setMessages(list)
        setLeafId(thread.active_leaf_id)
        setSummary(thread.context_summary)
        setContext(ctx)
        setPrefs(p)
        setTools(events)
        setLive({})
        // 読み込み中に届いた確認と、それ以前から回答待ちの確認をまとめて表示する
        setPermissions((list) => [
          ...waiting.filter((w) => !list.some((r) => r.requestId === w.requestId)),
          ...list
        ])
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
        void window.lumina.usage.context(threadId).then((r) => r.ok && setContext(r.value))
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
      if (event.type === 'threadUpdated') {
        onThreadChangedRef.current()
        return
      }
      setLive((map) => {
        const current = map[event.messageId] ?? { text: '', thinking: '', retry: null }
        const next =
          event.type === 'text'
            ? { ...current, text: current.text + event.text, retry: null, searching: null }
            : event.type === 'thinking'
              ? { ...current, thinking: current.thinking + event.text, retry: null }
              : event.type === 'webSearch'
                ? { ...current, searching: event.query || ja.chat.webSearchUnknown }
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

  const path = useMemo(() => activePath(messages, leafId), [messages, leafId])

  // SRC-01: 検索結果のメッセージを含む分岐を表示し、その位置までスクロールして強調する
  const [highlight, setHighlight] = useState<string | null>(null)
  useEffect(() => {
    if (!focusMessageId) return
    let active = true
    unwrap(window.lumina.threads.setActiveLeaf(threadId, focusMessageId))
      .then((thread) => {
        if (!active) return
        setLeafId(thread.active_leaf_id)
        setHighlight(focusMessageId)
        stickToBottom.current = false
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [threadId, focusMessageId])
  const generating = path.some((m) => m.status === 'streaming')
  const latestUserId = [...path].reverse().find((m) => m.role === 'user')?.id ?? null
  const last = path.at(-1)

  const rows = useMemo<LogRow[]>(() => {
    const list: LogRow[] = []
    if (summary) list.push({ kind: 'summary', key: 'summary' })
    path.forEach((m, i) => list.push({ kind: 'message', key: m.id, message: m, first: i === 0 }))
    if (
      last?.role === 'assistant' &&
      !generating &&
      // CHT-06: 通常チャットは完了した応答も再生成できる
      (!cowork || ['error', 'stopped', 'interrupted'].includes(last.status)) &&
      latestUserId
    ) {
      list.push({ kind: 'regenerate', key: 'regenerate', userMessageId: latestUserId })
    }
    return list
  }, [summary, path, last, generating, cowork, latestUserId])

  // 10.1: 長い会話でも滑らかに動くよう、見えている行（と前後の数行）だけを描画する。
  // 行の高さは描画後に測り直す（Markdown・思考の要約・生成中の伸びに追従する）
  // React Compiler は使っていないため、メモ化できない API の警告は対象外
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => logRef.current,
    estimateSize: () => 160,
    overscan: 6,
    getItemKey: (index) => rows[index].key
  })
  const totalSize = virtualizer.getTotalSize()

  // 該当の行が読み込まれたら、1 回だけその位置まで移動する
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    if (!highlight || scrolledFor.current === highlight) return
    const index = rows.findIndex((r) => r.key === highlight)
    if (index === -1) return
    scrolledFor.current = highlight
    stickToBottom.current = false
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [highlight, rows, virtualizer])
  useEffect(() => {
    if (!highlight) return
    const timer = setTimeout(() => setHighlight(null), 3000)
    return () => clearTimeout(timer)
  }, [highlight])

  // 末尾付近を見ているときだけ自動でスクロールする（行の高さを測り直したときも追従する）
  useEffect(() => {
    const el = logRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [rows, live, totalSize])

  const addMessages = (...added: Message[]): void => {
    setMessages((list) => [...list, ...added])
    // CHT-06: 新しい応答を表示中の分岐にする（main 側と同じ）
    const newest = added.at(-1)
    if (newest) setLeafId(newest.id)
    stickToBottom.current = true
  }

  /** 分岐の切り替え（CHT-06） */
  const switchBranch = async (messageId: string): Promise<void> => {
    try {
      const thread = await unwrap(window.lumina.threads.setActiveLeaf(threadId, messageId))
      setLeafId(thread.active_leaf_id)
    } catch (e) {
      fail(e)
    }
  }

  const compact = async (): Promise<void> => {
    setCompacting('running')
    setError(null)
    try {
      const next = await unwrap(window.lumina.chat.compact(threadId))
      onCompacted?.(next)
    } catch (e) {
      fail(e)
    } finally {
      setCompacting(null)
    }
  }

  const branchNav = (m: Message): React.ReactNode => {
    const { siblings, index } = siblingsOf(messages, m)
    if (siblings.length < 2) return null
    return (
      <span className="branch-nav">
        <button
          className="btn btn-sm"
          type="button"
          aria-label={ja.chat.prevBranch}
          disabled={index === 0 || generating}
          onClick={() => void switchBranch(siblings[index - 1].id)}
        >
          ‹
        </button>
        <span className="mono">{ja.chat.branch(index + 1, siblings.length)}</span>
        <button
          className="btn btn-sm"
          type="button"
          aria-label={ja.chat.nextBranch}
          disabled={index === siblings.length - 1 || generating}
          onClick={() => void switchBranch(siblings[index + 1].id)}
        >
          ›
        </button>
      </span>
    )
  }

  const contextRatio = context?.limit ? context.tokens / context.limit : 0

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

  // CMN-02: Esc で生成を停止する（確認ダイアログを閉じる Esc では停止しない）
  useShortcuts(generating ? { stop } : {})

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

  const renderRow = (row: LogRow): React.ReactNode => {
    if (row.kind === 'summary') {
      return (
        <details className="summary-note">
          <summary>{ja.chat.summaryNote}</summary>
          <div className="thinking-body">{summary}</div>
        </details>
      )
    }
    if (row.kind === 'regenerate') {
      return (
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => void regenerate(row.userMessageId)}
          >
            {ja.chat.regenerate}
          </button>
        </div>
      )
    }
    const m = row.message
    return m.role === 'user' ? (
      <UserRow
        message={m}
        first={row.first}
        highlighted={m.id === highlight}
        // CHT-06: 通常チャットはどのメッセージも編集できる。Cowork は最新の指示のみ（CHT-14）
        editable={!generating && (!cowork || m.id === latestUserId)}
        branch={branchNav(m)}
        allowAttachments={!cowork}
        onResend={(content, keep, added) => resend(m, content, keep, added)}
        onError={fail}
      />
    ) : (
      <AssistantRow
        message={m}
        first={row.first}
        highlighted={m.id === highlight}
        live={live[m.id]}
        cowork={cowork}
        tools={cowork ? tools.filter((t) => t.message_id === m.id) : []}
        generating={generating}
        branch={branchNav(m)}
      />
    )
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
        <div className="log-rows" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            return (
              <div
                key={item.key}
                className="log-slot"
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(row)}
              </div>
            )
          })}
        </div>
      </div>

      {error && (
        <p className="message message-error" role="alert">
          {error}
        </p>
      )}
      {!online && <p className="message message-info">{ja.chat.offline}</p>}

      {/* CTX-01: コンテキスト使用量。CTX-02: 80% で警告し、要約して続けることを提案する */}
      {!cowork && context && context.tokens > 0 && (
        <div className={`context-bar${contextRatio >= 0.8 ? ' warn' : ''}`}>
          <span className="mono">{ja.chat.context(context.tokens, context.limit)}</span>
          {contextRatio >= 0.8 && (
            <span>{ja.chat.contextWarning(Math.round(contextRatio * 100))}</span>
          )}
          <button
            className="btn btn-sm"
            type="button"
            disabled={generating || compacting !== null}
            onClick={() => setCompacting('confirm')}
          >
            {compacting === 'running' ? ja.chat.compacting : ja.chat.compact}
          </button>
        </div>
      )}
      {compacting === 'confirm' && (
        <ConfirmDialog
          title={ja.chat.compact}
          confirmLabel={ja.chat.compact}
          message={<p>{ja.chat.compactConfirm}</p>}
          onCancel={() => setCompacting(null)}
          onConfirm={() => void compact()}
        />
      )}

      {cowork && <TodoPanel todos={todos} />}

      <Composer
        sendKey={prefs.sendKey}
        generating={generating}
        disabled={!online}
        allowAttachments={!cowork}
        commands={commands}
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
  first,
  highlighted,
  editable,
  allowAttachments,
  branch,
  onResend,
  onError
}: {
  message: Message
  /** 会話の最初の行（区切り線を引かない） */
  first: boolean
  highlighted: boolean
  editable: boolean
  allowAttachments: boolean
  /** 分岐の切り替え（CHT-06） */
  branch: React.ReactNode
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
    <article
      className={`log-row log-user${first ? ' first' : ''}${highlighted ? ' highlighted' : ''}`}
      data-message-id={message.id}
    >
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
            {branch}
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
  first,
  highlighted,
  live,
  cowork,
  tools,
  generating,
  branch
}: {
  message: Message
  first: boolean
  highlighted: boolean
  live?: Live
  cowork: boolean
  tools: ToolEventInfo[]
  generating: boolean
  branch: React.ReactNode
}): React.JSX.Element {
  const streaming = message.status === 'streaming'
  const text = streaming ? (live?.text ?? '') : message.content
  const thinking = streaming ? (live?.thinking ?? '') : (message.thinking ?? '')

  return (
    <article
      className={`log-row log-assistant${first ? ' first' : ''}${highlighted ? ' highlighted' : ''}`}
      data-message-id={message.id}
      aria-busy={streaming}
    >
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
      {streaming && live?.searching && (
        <p className="hint">{ja.chat.webSearching(live.searching)}</p>
      )}
      {/* CHT-11: Web 検索の出典 */}
      {!streaming && message.sources.length > 0 && (
        <details className="sources">
          <summary>
            {message.sources.some((s) => s.cited)
              ? ja.chat.sources(message.sources.length)
              : ja.chat.searchResults(message.sources.length)}
          </summary>
          <ul>
            {message.sources
              .filter((s) => /^https?:\/\//i.test(s.url))
              .map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                    {s.title || s.url}
                  </a>
                </li>
              ))}
          </ul>
        </details>
      )}
      {message.status === 'stopped' && <p className="hint">{ja.chat.status.stopped}</p>}
      {message.status === 'interrupted' && <p className="hint">{ja.chat.status.interrupted}</p>}
      {message.status === 'error' && <p className="hint">{ja.chat.status.error}</p>}
      {message.stop_reason === 'refusal' && <p className="hint">{ja.chat.refusal}</p>}
      {message.stop_reason === 'max_tokens' && <p className="hint">{ja.chat.maxTokens}</p>}
      {/* CHT-13: 回答の下にコピーボタンを常時表示する（生成中は無効） */}
      <div className="log-actions">
        {branch}
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
  commands,
  onSend,
  onStop,
  onError
}: {
  sendKey: ChatPrefs['sendKey']
  generating: boolean
  disabled: boolean
  allowAttachments: boolean
  commands: SlashCommand[]
  onSend: (content: string, attachments: AttachmentInfo[]) => Promise<boolean>
  onStop: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const staging = useStaging(onError)

  const canSend =
    !generating && !disabled && !sending && (text.trim() !== '' || staging.items.length > 0)

  // 6.6: 「/名前」で候補を出し、選ぶと本文を展開する（送信前に内容を確認できる）
  const typed = parseCommandInput(text)
  const suggestions =
    typed && !text.includes('\n')
      ? commands.filter((c) => c.name.startsWith(typed.name)).slice(0, 8)
      : []
  const applyCommand = (command: SlashCommand): void =>
    setText(expandCommand(command.content, typed?.args ?? ''))

  // CHT-12: スニペットをカーソル位置に挿入する（選択中の文字は置き換える）
  const insertSnippet = (content: string): void => {
    const el = inputRef.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    setText(text.slice(0, start) + content + text.slice(end))
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + content.length, start + content.length)
    })
  }

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
      {suggestions.length > 0 && (
        <ul className="command-list" role="listbox" aria-label={ja.chat.commands}>
          {suggestions.map((c) => (
            <li key={c.name}>
              <button type="button" className="command-item" onClick={() => applyCommand(c)}>
                <span className="mono">/{c.name}</span>
                {c.description && <span className="hint">{c.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={inputRef}
        className="input textarea composer-input"
        value={text}
        placeholder={ja.chat.placeholder(sendKey)}
        aria-label={ja.chat.placeholder(sendKey)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="row">
          {allowAttachments && (
            <button className="btn btn-sm" type="button" onClick={() => void staging.select()}>
              📎 {ja.chat.attach}
            </button>
          )}
          <SnippetPicker disabled={disabled} onInsert={insertSnippet} />
        </span>
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
