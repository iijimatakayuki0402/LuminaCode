import { useEffect, useId, useRef } from 'react'
import { ja } from '../locales/ja'

/**
 * モーダルダイアログ（HTML の dialog 要素。Esc で閉じ、フォーカスはダイアログ内に留まる）
 */
export function Dialog({
  title,
  danger = false,
  onClose,
  children,
  footer
}: {
  title: string
  danger?: boolean
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      className={`dialog${danger ? ' danger' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="dialog-head" id={titleId}>
        {title}
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-foot">{footer}</div>
    </dialog>
  )
}

/**
 * 確認ダイアログ。danger は削除などの危険操作（要件 10.3: 見た目を区別し、対象を明示する）
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}: {
  title: string
  message: React.ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Dialog
      title={title}
      danger={danger}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" type="button" onClick={onCancel} autoFocus disabled={busy}>
            {ja.common.cancel}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            type="button"
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message}
    </Dialog>
  )
}
