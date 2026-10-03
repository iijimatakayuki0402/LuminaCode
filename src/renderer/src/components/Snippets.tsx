/**
 * 定型プロンプト（スニペット。要件 CHT-12）
 * 設定画面で管理し、入力欄の「スニペット」から選んでカーソル位置に挿入する。
 * CHT-15: {{名前}} の変数があれば、値を入力してから挿入する。
 */

import { useEffect, useId, useState } from 'react'
import { fillSnippet, snippetVariables } from '@shared/snippetVariables'
import type { Snippet } from '@shared/types'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'
import { ConfirmDialog, Dialog } from './Dialog'
import { Message, type MessageState } from './Message'

const EMPTY = { id: undefined as string | undefined, name: '', content: '' }

/**
 * 設定画面の節（追加・編集・削除）
 */
export function SnippetsSection(): React.JSX.Element {
  const nameId = useId()
  const contentId = useId()
  const [list, setList] = useState<Snippet[]>([])
  const [form, setForm] = useState(EMPTY)
  const [removing, setRemoving] = useState<Snippet | null>(null)
  const [message, setMessage] = useState<MessageState | null>(null)

  useEffect(() => {
    let active = true
    unwrap(window.lumina.snippets.list())
      .then((l) => active && setList(l))
      .catch((e: unknown) => active && setMessage({ tone: 'error', text: (e as Error).message }))
    return () => {
      active = false
    }
  }, [])

  const save = async (): Promise<void> => {
    try {
      setList(await unwrap(window.lumina.snippets.save(form)))
      setMessage({ tone: 'info', text: ja.snippets.saved })
      setForm(EMPTY)
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  const remove = async (snippet: Snippet): Promise<void> => {
    setRemoving(null)
    try {
      setList(await unwrap(window.lumina.snippets.delete(snippet.id)))
      if (form.id === snippet.id) setForm(EMPTY)
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  return (
    <section className="panel" aria-labelledby="settings-snippets">
      <h2 id="settings-snippets">{ja.snippets.section}</h2>
      <p className="hint">{ja.snippets.note}</p>
      <p className="hint">{ja.snippets.variablesNote}</p>
      {list.length === 0 ? (
        <p className="hint">{ja.snippets.none}</p>
      ) : (
        <ul className="snippet-list">
          {list.map((s) => (
            <li key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="snippet-name" title={s.content}>
                {s.name}
              </span>
              <span className="row">
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => setForm({ id: s.id, name: s.name, content: s.content })}
                >
                  {ja.common.edit}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => setRemoving(s)}
                >
                  {ja.common.delete}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="field">
        <label htmlFor={nameId}>{ja.snippets.name}</label>
        <input
          id={nameId}
          className="input"
          value={form.name}
          maxLength={50}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={contentId}>{ja.snippets.content}</label>
        <textarea
          id={contentId}
          className="input textarea"
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
        />
        <span className="hint">{ja.projectDialog.count([...form.content].length, 20000)}</span>
      </div>
      <div className="row">
        <button
          className="btn btn-primary"
          type="button"
          disabled={form.name.trim() === '' || form.content.trim() === ''}
          onClick={() => void save()}
        >
          {form.id ? ja.snippets.update : ja.snippets.add}
        </button>
        {form.id && (
          <button className="btn" type="button" onClick={() => setForm(EMPTY)}>
            {ja.common.cancel}
          </button>
        )}
      </div>
      <Message message={message} />
      {removing && (
        <ConfirmDialog
          title={ja.snippets.deleteTitle}
          message={ja.snippets.deleteConfirm(removing.name)}
          confirmLabel={ja.common.delete}
          danger
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  )
}

/**
 * 入力欄の「スニペット」ボタンと一覧。選ぶと onInsert に内容を渡す
 */
export function SnippetPicker({
  disabled,
  onInsert
}: {
  disabled: boolean
  onInsert: (content: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Snippet[] | null>(null)
  const [filter, setFilter] = useState('')
  /** CHT-15: 変数の値を入力中のスニペット */
  const [filling, setFilling] = useState<Snippet | null>(null)

  const choose = (snippet: Snippet): void => {
    setOpen(false)
    if (snippetVariables(snippet.content).length > 0) setFilling(snippet)
    else onInsert(snippet.content)
  }

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setFilter('')
    // 設定画面での変更を反映するため、開くたびに読み直す
    void unwrap(window.lumina.snippets.list())
      .then(setList)
      .catch(() => setList([]))
  }

  const shown = (list ?? []).filter(
    (s) => filter === '' || s.name.includes(filter) || s.content.includes(filter)
  )

  return (
    <span className="snippet-picker">
      <button
        className="btn btn-sm"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={toggle}
      >
        {ja.snippets.button}
      </button>
      {open && (
        <div className="snippet-popup" role="dialog" aria-label={ja.snippets.section}>
          <input
            className="input"
            autoFocus
            placeholder={ja.snippets.filter}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />
          {list === null ? (
            <p className="hint">{ja.common.loading}</p>
          ) : shown.length === 0 ? (
            <p className="hint">
              {list.length === 0 ? ja.snippets.emptyPicker : ja.snippets.noMatch}
            </p>
          ) : (
            <ul className="command-list" role="listbox">
              {shown.map((s) => (
                <li key={s.id}>
                  <button type="button" className="command-item" onClick={() => choose(s)}>
                    <span>
                      {s.name}
                      {snippetVariables(s.content).length > 0 && (
                        <span className="hint">
                          {' '}
                          ({ja.snippets.variables(snippetVariables(s.content).length)})
                        </span>
                      )}
                    </span>
                    <span className="hint">{s.content.slice(0, 60)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {filling && (
        <FillDialog
          snippet={filling}
          onCancel={() => setFilling(null)}
          onInsert={(content) => {
            setFilling(null)
            onInsert(content)
          }}
        />
      )}
    </span>
  )
}

/**
 * 変数の値を入力するダイアログ（CHT-15）。同じ名前の変数は 1 つの入力欄にまとめる
 */
function FillDialog({
  snippet,
  onCancel,
  onInsert
}: {
  snippet: Snippet
  onCancel: () => void
  onInsert: (content: string) => void
}): React.JSX.Element {
  const names = snippetVariables(snippet.content)
  const [values, setValues] = useState<Record<string, string>>({})
  const formId = useId()
  return (
    <Dialog
      title={ja.snippets.fillTitle(snippet.name)}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" type="button" onClick={onCancel}>
            {ja.common.cancel}
          </button>
          <button className="btn btn-primary" type="submit" form={formId}>
            {ja.snippets.insert}
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          onInsert(fillSnippet(snippet.content, values))
        }}
      >
        {names.map((name, i) => (
          <div className="field" key={name}>
            <label htmlFor={`${formId}-${i}`}>{name}</label>
            <textarea
              id={`${formId}-${i}`}
              className="input textarea snippet-value"
              rows={2}
              autoFocus={i === 0}
              value={values[name] ?? ''}
              onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              onKeyDown={(e) => {
                // Ctrl+Enter で挿入する（Enter は改行）
                if (e.key === 'Enter' && e.ctrlKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  onInsert(fillSnippet(snippet.content, values))
                }
              }}
            />
          </div>
        ))}
        <p className="hint">{snippet.content.slice(0, 200)}</p>
      </form>
    </Dialog>
  )
}
