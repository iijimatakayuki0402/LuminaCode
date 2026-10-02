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
  attachments: AttachmentStore
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
  attachments
}: HandlerDeps): IpcHandlers {
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

    'chat:send': (input) => chatService.send(v.sendMessageInput(input, 'input')),
    'chat:regenerate': (userMessageId) =>
      chatService.regenerate(v.id(userMessageId, 'userMessageId')),
    'chat:editAndResend': (input) =>
      chatService.editAndResend(v.editAndResendInput(input, 'input')),
    'chat:stop': (threadId) => chatService.stop(v.id(threadId, 'threadId')),

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
