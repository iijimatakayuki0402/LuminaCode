import { useEffect, useId, useState } from 'react'
import type { PermissionMode, Project, ProjectTemplate, ProjectType } from '@shared/types'
import { unwrap } from '../lib/ipc'
import { useModels } from '../lib/useModels'
import { ja } from '../locales/ja'
import { ConfirmDialog, Dialog } from './Dialog'
import { Message, type MessageState } from './Message'
import { TypeIcon } from './TypeBadge'

const NAME_MAX = 100
const INSTRUCTIONS_MAX = 20000
const PERMISSION_MODES: PermissionMode[] = ['confirm_each', 'auto_edit', 'plan_only']

// main 側の検証（ValidationError）と同じく文字（コードポイント）単位で数える
const charLength = (value: string): number => [...value].length

export type ProjectDialogMode =
  { kind: 'create' } | { kind: 'edit'; project: Project } | { kind: 'duplicate'; project: Project }

/**
 * プロジェクトの作成・編集・複製（要件 6.2、PRJ-01〜07、DSH-05）
 * 種別は作成時のみ選べる（PRJ-04）。複製では種別を選び直して作り直せる。
 */
export function ProjectDialog({
  mode,
  onDone,
  onCancel
}: {
  mode: ProjectDialogMode
  onDone: (project: Project) => void
  onCancel: () => void
}): React.JSX.Element {
  const ids = {
    name: useId(),
    instructions: useId(),
    folder: useId(),
    model: useId(),
    perm: useId(),
    template: useId()
  }
  const source = mode.kind === 'create' ? null : mode.project
  const { models, defaultModel } = useModels()

  const [type, setType] = useState<ProjectType>(source?.type ?? 'chat')
  const [name, setName] = useState(
    mode.kind === 'duplicate'
      ? `${mode.project.name}${ja.dashboard.copySuffix}`
      : (source?.name ?? '')
  )
  const [instructions, setInstructions] = useState(source?.custom_instructions ?? '')
  const [workFolder, setWorkFolder] = useState(source?.work_folder ?? '')
  const [model, setModel] = useState(source?.model ?? '')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    source?.permission_mode ?? 'confirm_each'
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<MessageState | null>(null)
  const [confirmFolder, setConfirmFolder] = useState(false)
  // PRJ-09: 新規作成ではテンプレートを選べる
  const [templates, setTemplates] = useState<ProjectTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  const [deletingTemplate, setDeletingTemplate] = useState<ProjectTemplate | null>(null)
  const template = templates.find((t) => t.id === templateId) ?? null

  useEffect(() => {
    if (mode.kind !== 'create') return
    let active = true
    unwrap(window.lumina.templates.list())
      .then((list) => active && setTemplates(list))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [mode.kind])

  const applyTemplate = (id: string): void => {
    setTemplateId(id)
    const t = templates.find((x) => x.id === id)
    if (!t) return
    setType(t.type)
    setInstructions(t.custom_instructions ?? '')
    setModel(t.model ?? '')
    setPermissionMode(t.permission_mode ?? 'confirm_each')
  }

  const removeTemplate = async (t: ProjectTemplate): Promise<void> => {
    setDeletingTemplate(null)
    try {
      setTemplates(await unwrap(window.lumina.templates.delete(t.id)))
      setTemplateId('')
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  const isEdit = mode.kind === 'edit'
  const isCowork = type === 'cowork'
  const nameLength = charLength(name)
  const instructionsLength = charLength(instructions)
  // PRJ-02、PRJ-03: 名前が空、または Cowork で作業フォルダが未指定なら保存できない
  const canSubmit =
    !busy &&
    name.trim() !== '' &&
    nameLength <= NAME_MAX &&
    instructionsLength <= INSTRUCTIONS_MAX &&
    (!isCowork || workFolder.trim() !== '')

  const browse = async (): Promise<void> => {
    try {
      const picked = await unwrap(window.lumina.dialog.selectFolder(workFolder || undefined))
      if (picked) setWorkFolder(picked)
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const common = {
        name,
        custom_instructions: instructions,
        model,
        ...(isCowork ? { work_folder: workFolder, permission_mode: permissionMode } : {})
      }
      const project = isEdit
        ? await unwrap(window.lumina.projects.update(mode.project.id, common))
        : await unwrap(window.lumina.projects.create({ type, ...common }))
      // PRJ-09: テンプレートの Web の設定を引き継ぐ
      if (template?.web_access) {
        await unwrap(window.lumina.cowork.setSettings(project.id, { webAccess: true }))
      }
      onDone(project)
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
      setBusy(false)
    }
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    // PRJ-07: 作業フォルダの変更は確認する
    if (isEdit && isCowork && workFolder !== mode.project.work_folder) {
      setConfirmFolder(true)
      return
    }
    void save()
  }

  const title =
    mode.kind === 'create'
      ? ja.projectDialog.createTitle
      : mode.kind === 'edit'
        ? ja.projectDialog.editTitle
        : ja.projectDialog.duplicateTitle

  return (
    <>
      <Dialog
        title={title}
        onClose={onCancel}
        footer={
          <>
            <button className="btn" type="button" onClick={onCancel} disabled={busy}>
              {ja.common.cancel}
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              form="project-form"
              disabled={!canSubmit}
            >
              {isEdit ? ja.projectDialog.submitSave : ja.projectDialog.submitCreate}
            </button>
          </>
        }
      >
        <form id="project-form" onSubmit={submit}>
          {mode.kind === 'create' && templates.length > 0 && (
            <div className="field">
              <label htmlFor={ids.template}>{ja.templates.select}</label>
              <div className="row">
                <select
                  id={ids.template}
                  className="select"
                  style={{ flex: 1 }}
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  disabled={busy}
                >
                  <option value="">{ja.templates.none}</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}（{ja.projectType[t.type]}）
                    </option>
                  ))}
                </select>
                {template && (
                  <button
                    className="btn btn-sm btn-danger"
                    type="button"
                    onClick={() => setDeletingTemplate(template)}
                    disabled={busy}
                  >
                    {ja.templates.delete}
                  </button>
                )}
              </div>
            </div>
          )}
          <fieldset className="field" style={{ border: 'none', padding: 0, margin: '0 0 0.9rem' }}>
            <legend className="hint" style={{ marginBottom: '0.35rem' }}>
              {ja.projectDialog.type}
            </legend>
            <div className="segmented">
              {(['chat', 'cowork'] as const).map((t) => (
                <label key={t} className={`type-${t}`}>
                  <input
                    type="radio"
                    name="project-type"
                    value={t}
                    checked={type === t}
                    onChange={() => setType(t)}
                    disabled={isEdit || busy}
                  />
                  <TypeIcon type={t} />
                  {ja.projectType[t]}
                </label>
              ))}
            </div>
            {isEdit && <span className="hint">{ja.projectDialog.typeLocked}</span>}
          </fieldset>

          <div className="field">
            <label htmlFor={ids.name}>{ja.projectDialog.name}</label>
            <input
              id={ids.name}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              disabled={busy}
              aria-invalid={nameLength > NAME_MAX}
            />
            <span className="hint">{ja.projectDialog.count(nameLength, NAME_MAX)}</span>
          </div>

          {isCowork && (
            <div className="field">
              <label htmlFor={ids.folder}>{ja.projectDialog.workFolder}</label>
              <div className="row">
                <input
                  id={ids.folder}
                  className="input mono"
                  style={{ flex: 1 }}
                  value={workFolder}
                  onChange={(e) => setWorkFolder(e.target.value)}
                  required
                  disabled={busy}
                />
                <button className="btn" type="button" onClick={() => void browse()} disabled={busy}>
                  {ja.projectDialog.browse}
                </button>
              </div>
              <span className="hint">{ja.projectDialog.workFolderHint}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor={ids.instructions}>{ja.projectDialog.customInstructions}</label>
            <textarea
              id={ids.instructions}
              className="input textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={busy}
              aria-invalid={instructionsLength > INSTRUCTIONS_MAX}
            />
            <span className="hint">
              {ja.projectDialog.count(instructionsLength, INSTRUCTIONS_MAX)}
            </span>
          </div>

          <div className="field">
            <label htmlFor={ids.model}>{ja.projectDialog.model}</label>
            <select
              id={ids.model}
              className="select mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
            >
              <option value="">{ja.projectDialog.useDefault(defaultModel)}</option>
              {model !== '' && !models.some((m) => m.id === model) && (
                <option value={model}>{model}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} ({m.id})
                </option>
              ))}
            </select>
          </div>

          {isCowork && (
            <div className="field">
              <label htmlFor={ids.perm}>{ja.projectDialog.permissionMode}</label>
              <select
                id={ids.perm}
                className="select"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                disabled={busy}
              >
                {PERMISSION_MODES.map((p) => (
                  <option key={p} value={p}>
                    {ja.permissionMode[p]}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Message message={message} />
        </form>
      </Dialog>

      {deletingTemplate && (
        <ConfirmDialog
          title={ja.templates.delete}
          message={ja.templates.deleteConfirm(deletingTemplate.name)}
          confirmLabel={ja.common.delete}
          danger
          onConfirm={() => void removeTemplate(deletingTemplate)}
          onCancel={() => setDeletingTemplate(null)}
        />
      )}

      {confirmFolder && isEdit && (
        <ConfirmDialog
          title={ja.projectDialog.changeFolderTitle}
          confirmLabel={ja.projectDialog.changeFolderConfirm}
          onCancel={() => setConfirmFolder(false)}
          onConfirm={() => {
            setConfirmFolder(false)
            void save()
          }}
          message={
            <>
              <p>{ja.projectDialog.changeFolderLead}</p>
              <p className="mono">
                {ja.projectDialog.changeFolderFrom}: {mode.project.work_folder}
                <br />
                {ja.projectDialog.changeFolderTo}: {workFolder}
              </p>
            </>
          }
        />
      )}
    </>
  )
}
