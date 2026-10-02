import { useId, useState } from 'react'
import type { ImportPreview, Project } from '@shared/types'
import { unwrap } from '../lib/ipc'
import { ja } from '../locales/ja'
import { Dialog } from './Dialog'
import { TypeBadge } from './TypeBadge'

/**
 * プロジェクトの読み込み（EXP-01）。Cowork は作業フォルダを指定し直す（EXP-05）
 */
export function ImportDialog({
  preview,
  onDone,
  onCancel
}: {
  preview: ImportPreview
  onDone: (project: Project) => void
  onCancel: () => void
}): React.JSX.Element {
  const folderId = useId()
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cowork = preview.type === 'cowork'

  const browse = async (): Promise<void> => {
    const picked = await unwrap(window.lumina.dialog.selectFolder(folder || undefined)).catch(
      () => null
    )
    if (picked) setFolder(picked)
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onDone(await unwrap(window.lumina.data.importConfirm(preview.token, cowork ? folder : null)))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={ja.exchange.importTitle}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            {ja.common.cancel}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void confirm()}
            disabled={busy || (cowork && folder.trim() === '')}
          >
            {ja.exchange.confirm}
          </button>
        </>
      }
    >
      <p className="row">
        <TypeBadge type={preview.type} />
        <strong>{preview.name}</strong>
      </p>
      <p className="hint">
        {ja.exchange.importSummary(preview.threads, preview.messages, preview.attachments)}
        <br />
        {ja.exchange.exportedAt(new Date(preview.exported_at).toLocaleString('ja-JP'))}
      </p>
      {cowork && (
        <div className="field">
          <p className="hint">
            {preview.work_folder && ja.exchange.originalFolder(preview.work_folder)}
            <br />
            {ja.exchange.chooseFolder}
          </p>
          <label htmlFor={folderId}>{ja.projectDialog.workFolder}</label>
          <div className="row">
            <input
              id={folderId}
              className="input mono"
              style={{ flex: 1 }}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <button className="btn" type="button" onClick={() => void browse()}>
              {ja.projectDialog.browse}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="message message-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
