/**
 * IPC ハンドラー
 * Electron に依存しない形で定義し、登録（register.ts）と分けてテストできるようにする。
 */

import type Database from 'better-sqlite3'
import type { AppInfo, IpcChannel, IpcReturn } from '@shared/ipc'
import type { ClientFactory } from '../api/client'
import { testApiKey } from '../api/connection'
import * as ops from '../db/operations'
import type { ModelService } from '../models/modelService'
import { normalizeApiKey, type ApiKeyStore } from '../secrets/apiKeyStore'
import { validateWorkFolder, type WorkFolderPolicy } from '../security/workFolder'
import { getAppearance, setAppearance } from '../settings/appearance'
import { getChatPrefs, setChatPrefs } from '../settings/chatPrefs'
import type { AttachmentStore } from '../chat/attachments'
import type { ChatService } from '../chat/chatService'
import type { CoworkService } from '../cowork/coworkService'
import { listTrash, purgeTrash, restoreFromTrash } from '../cowork/trash'
import { deleteToolEventsBefore, formatToolEvents, searchToolEvents } from '../cowork/toolEvents'
import type { AttachmentInfo, StageResult } from '@shared/types'
import { NotFoundError } from './errors'
import * as v from './validate'

export type IpcHandlers = {
  [C in IpcChannel]: (...args: unknown[]) => IpcReturn<C> | Promise<IpcReturn<C>>
}

export interface HandlerDeps {
  db: Database.Database
  appInfo: AppInfo
  apiKeyStore: ApiKeyStore
  modelService: ModelService
  createClient: ClientFactory
  workFolderPolicy: WorkFolderPolicy
  /** フォルダ選択ダイアログを表示する（Electron 依存のため外から渡す） */
  selectFolder: (defaultPath?: string) => Promise<string | null>
  /** ファイル選択ダイアログを表示する（複数選択。キャンセル時は空） */
  selectFiles: () => Promise<string[]>
  chatService: ChatService
  coworkService: CoworkService
  attachments: AttachmentStore
  /** 保存ダイアログで保存先を選び、内容を書き込む（キャンセル時は null） */
  saveFile: (defaultName: string, content: string) => Promise<string | null>
}

/** 複数ファイルを仮置きし、失敗したものは理由をまとめて返す */
function stageAll(items: (() => AttachmentInfo)[]): StageResult {
  const result: StageResult = { staged: [], errors: [] }
  for (const stage of items) {
    try {
      result.staged.push(stage())
    } catch (error) {
      if (!(error instanceof ops.ValidationError)) throw error
      result.errors.push(error.message)
    }
  }
  return result
}

function found<T>(value: T | null, message: string): T {
  if (value === null) throw new NotFoundError(message)
  return value
}

function deleted(changed: boolean, message: string): void {
  if (!changed) throw new NotFoundError(message)
}

const PROJECT_NOT_FOUND = 'プロジェクトが見つかりません。'
const THREAD_NOT_FOUND = 'スレッドが見つかりません。'
const API_KEY_NOT_CONFIGURED = 'API キーが設定されていません。'

export function createHandlers({
  db,
  appInfo,
  apiKeyStore,
  modelService,
  createClient,
  workFolderPolicy,
  selectFolder,
  selectFiles,
  chatService,
  coworkService,
  attachments,
  saveFile
}: HandlerDeps): IpcHandlers {
  // 通常チャットと Cowork の振り分け（スレッドが属するプロジェクトの種別で決める）
  const engineForThread = (threadId: string): ChatService | CoworkService => {
    const thread = found(ops.getThread(db, threadId), THREAD_NOT_FOUND)
    const project = found(ops.getProject(db, thread.project_id), PROJECT_NOT_FOUND)
    return project.type === 'cowork' ? coworkService : chatService
  }
  const engineForMessage = (messageId: string): ChatService | CoworkService => {
    const message = found(ops.getMessage(db, messageId), 'メッセージが見つかりません。')
    return engineForThread(message.thread_id)
  }
  const workFolderOf = (projectId: string): string => {
    const project = found(ops.getProject(db, projectId), PROJECT_NOT_FOUND)
    if (project.type !== 'cowork' || !project.work_folder) {
      throw new ops.ValidationError('Cowork のプロジェクトではありません。')
    }
    return project.work_folder
  }

  // 作業フォルダは要件 PRJ-05 の検証を通し、実体パスで保存する
  const checkWorkFolder = <T extends { work_folder?: string }>(input: T): T =>
    input.work_folder
      ? { ...input, work_folder: validateWorkFolder(input.work_folder, workFolderPolicy) }
      : input

  return {
    'app:getInfo': () => appInfo,

    'projects:list': (options) =>
      ops.listProjects(db, v.optional(v.listProjectsOptions)(options, 'options')),
    'projects:get': (projectId) =>
      found(ops.getProject(db, v.id(projectId, 'id')), PROJECT_NOT_FOUND),
    'projects:create': (input) =>
      ops.createProject(db, checkWorkFolder(v.createProjectInput(input, 'input'))),
    'projects:update': (projectId, input) =>
      found(
        ops.updateProject(
          db,
          v.id(projectId, 'id'),
          checkWorkFolder(v.updateProjectInput(input, 'input'))
        ),
        PROJECT_NOT_FOUND
      ),
    'projects:delete': (projectId) =>
      deleted(ops.deleteProject(db, v.id(projectId, 'id')), PROJECT_NOT_FOUND),

    'threads:listByProject': (projectId) =>
      ops.listThreadsByProject(db, v.id(projectId, 'projectId')),
    'threads:create': (input) => {
      const checked = v.createThreadInput(input, 'input')
      found(ops.getProject(db, checked.project_id), PROJECT_NOT_FOUND)
      return ops.createThread(db, checked)
    },
    'threads:update': (threadId, input) =>
      found(
        ops.updateThread(db, v.id(threadId, 'id'), v.updateThreadInput(input, 'input')),
        THREAD_NOT_FOUND
      ),
    'threads:delete': (threadId) =>
      deleted(ops.deleteThread(db, v.id(threadId, 'id')), THREAD_NOT_FOUND),
    'threads:markOpened': (threadId) =>
      deleted(ops.markThreadOpened(db, v.id(threadId, 'id')), THREAD_NOT_FOUND),
    'threads:getLastOpened': (projectId) =>
      ops.getLastOpenedThread(db, v.id(projectId, 'projectId')),

    'messages:listByThread': (threadId) => chatService.listMessages(v.id(threadId, 'threadId')),

    'apiKey:getStatus': () => apiKeyStore.status(),
    'apiKey:save': async (input) => {
      const apiKey = normalizeApiKey(v.str(input, 'apiKey'))
      await testApiKey(createClient, apiKey)
      apiKeyStore.save(apiKey)
      // 一覧の取得と既定モデルの設定は、保存の成否に影響させない
      await modelService.list(true).catch(() => undefined)
      return apiKeyStore.status()
    },
    'apiKey:test': async () => {
      const apiKey = apiKeyStore.get()
      if (apiKey === null) throw new ops.ValidationError(API_KEY_NOT_CONFIGURED)
      await testApiKey(createClient, apiKey)
    },
    'apiKey:delete': () => {
      apiKeyStore.delete()
      return apiKeyStore.status()
    },

    'models:list': (refresh) => modelService.list(v.optional(v.bool)(refresh, 'refresh') ?? false),
    'models:getDefault': () => modelService.getDefaultModel(),
    'models:setDefault': (modelId) => modelService.setDefaultModel(v.str(modelId, 'modelId')),

    'settings:getAppearance': () => getAppearance(db),
    'settings:setAppearance': (input) => setAppearance(db, v.appearanceInput(input, 'input')),

    'settings:getChatPrefs': () => getChatPrefs(db),
    'settings:setChatPrefs': (input) => setChatPrefs(db, v.chatPrefsInput(input, 'input')),

    'chat:send': (input) => {
      const checked = v.sendMessageInput(input, 'input')
      return engineForThread(checked.threadId).send(checked)
    },
    'chat:regenerate': (userMessageId) => {
      const messageId = v.id(userMessageId, 'userMessageId')
      return engineForMessage(messageId).regenerate(messageId)
    },
    'chat:editAndResend': (input) => {
      const checked = v.editAndResendInput(input, 'input')
      return engineForMessage(checked.userMessageId).editAndResend(checked)
    },
    'chat:stop': (threadId) => {
      const checked = v.id(threadId, 'threadId')
      engineForThread(checked).stop(checked)
    },

    'cowork:respond': (requestId, response) =>
      coworkService.respond(
        v.id(requestId, 'requestId'),
        v.permissionResponse(response, 'response')
      ),
    'cowork:toolEvents': (threadId) => coworkService.listToolEvents(v.id(threadId, 'threadId')),
    'cowork:changes': (messageId) => coworkService.listChanges(v.id(messageId, 'messageId')),
    'cowork:undo': (messageId) => coworkService.undo(v.id(messageId, 'messageId')),
    'cowork:diff': (snapshotId) => coworkService.diff(v.id(snapshotId, 'snapshotId')),
    'cowork:trashList': (projectId) => listTrash(workFolderOf(v.id(projectId, 'projectId'))),
    'cowork:trashRestore': (projectId, entryId) =>
      restoreFromTrash(workFolderOf(v.id(projectId, 'projectId')), v.str(entryId, 'entryId')),
    'cowork:trashPurge': (projectId, days) =>
      purgeTrash(workFolderOf(v.id(projectId, 'projectId')), v.num(days, 'olderThanDays')),
    'cowork:getAlways': (projectId, threadId) =>
      coworkService.getAlways(
        v.id(projectId, 'projectId'),
        v.optional(v.id)(threadId, 'threadId') ?? ''
      ),
    'cowork:clearAlways': (scope, id) =>
      coworkService.clearAlways(v.scope(scope, 'scope'), v.id(id, 'id')),
    'cowork:getPrefs': () => coworkService.getPrefs(),
    'cowork:setPrefs': (input) => coworkService.setPrefs(v.coworkPrefsInput(input, 'input')),

    'logs:search': (filter) => searchToolEvents(db, v.toolEventFilter(filter, 'filter')),
    'logs:export': (filter, format) => {
      const checkedFormat = v.exportFormat(format, 'format')
      const rows = searchToolEvents(db, { ...v.toolEventFilter(filter, 'filter'), limit: 100_000 })
      const date = new Date().toISOString().slice(0, 10)
      return saveFile(
        `lumina-tool-log-${date}.${checkedFormat}`,
        formatToolEvents(rows, checkedFormat)
      )
    },
    'logs:deleteBefore': (before) => deleteToolEventsBefore(db, v.num(before, 'before')),

    'attachments:select': async () =>
      stageAll((await selectFiles()).map((p) => () => attachments.stageFromPath(p))),
    'attachments:stagePaths': (input) =>
      stageAll(v.paths(input, 'paths').map((p) => () => attachments.stageFromPath(p))),
    'attachments:stageData': (filename, data) => {
      const name = v.str(filename, 'filename')
      const content = v.bytes(data, 'data')
      return stageAll([() => attachments.stageFromData(name, content)])
    },
    'attachments:discard': (attachmentId) => attachments.discard(v.id(attachmentId, 'id')),

    'dialog:selectFolder': (defaultPath) =>
      selectFolder(v.optional(v.str)(defaultPath, 'defaultPath'))
  }
}
