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
import { getGlobalInstructions, setGlobalInstructions } from '../settings/instructions'
import { leafFrom } from '@shared/conversation'
import type { AttachmentStore } from '../chat/attachments'
import type { ChatService } from '../chat/chatService'
import type { CoworkService } from '../cowork/coworkService'
import type { UsageService } from '../usage/usageService'
import { search } from '../search/searchService'
import { backupNow, listBackups } from '../data/backup'
import {
  exportProject,
  importBundle,
  parseBundle,
  previewBundle,
  threadToMarkdown,
  type ProjectBundle
} from '../data/projectBundle'
import { randomUUID } from 'node:crypto'
import { listTrash, purgeTrash, restoreFromTrash } from '../cowork/trash'
import { listDir, readPreview } from '../cowork/files'
import {
  getCoworkSettings,
  listSlashCommands,
  setCoworkSettings,
  setSkillsTrust,
  skillsStatus
} from '../cowork/extensions'
import type { McpStore } from '../cowork/mcpStore'
import { deleteToolEventsBefore, formatToolEvents, searchToolEvents } from '../cowork/toolEvents'
import { clearAppLog } from '../logging/appLog'
import type { AttachmentInfo, LicenseList, StageResult } from '@shared/types'
import type { UpdateService } from '../update/updateService'
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
  usage: UsageService
  mcp: McpStore
  attachments: AttachmentStore
  /** 保存ダイアログで保存先を選び、内容を書き込む（キャンセル時は null） */
  saveFile: (defaultName: string, content: string) => Promise<string | null>
  /** 読み込むファイルを選び、内容を返す（キャンセル時は null） */
  openTextFile: (filters: { name: string; extensions: string[] }[]) => Promise<string | null>
  /** DB のバックアップ先（10.2） */
  backupDir: string
  /** 同梱しているオープンソースのライセンス（6.12） */
  readLicenses: () => LicenseList
  /** 更新（CMN-03） */
  update: UpdateService
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
/** CMN-05: 最後に開いていたプロジェクト */
const LAST_PROJECT_KEY = 'last_project_id'

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
  usage,
  mcp,
  attachments,
  saveFile,
  openTextFile,
  backupDir,
  readLicenses,
  update
}: HandlerDeps): IpcHandlers {
  // 読み込み前に確認した内容（確定するまで main で保持する）
  const pendingImports = new Map<string, ProjectBundle>()
  const safeName = (name: string): string =>
    name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'export'

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
    'app:licenses': () => readLicenses(),
    'app:getLastProject': () => {
      const projectId = ops.getSetting(db, LAST_PROJECT_KEY)
      const project = projectId ? ops.getProject(db, projectId) : null
      return project && !project.archived ? project : null
    },
    'app:setLastProject': (projectId) => {
      if (projectId === null) ops.deleteSetting(db, LAST_PROJECT_KEY)
      else ops.setSetting(db, LAST_PROJECT_KEY, v.id(projectId, 'projectId'))
    },

    'update:getStatus': () => update.getStatus(),
    'update:check': () => update.check(),
    'update:download': () => update.download(),
    'update:install': () => update.install(),

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
    'threads:update': (threadId, input) => {
      const checked = v.updateThreadInput(input, 'input')
      return found(
        ops.updateThread(db, v.id(threadId, 'id'), {
          ...checked,
          // THR-03: 手動で変更したタイトルは自動生成で上書きしない
          ...(checked.title !== undefined ? { title_source: 'manual' as const } : {})
        }),
        THREAD_NOT_FOUND
      )
    },
    'threads:get': (threadId) => found(ops.getThread(db, v.id(threadId, 'id')), THREAD_NOT_FOUND),
    'threads:setActiveLeaf': (threadId, messageId) => {
      const id = v.id(threadId, 'threadId')
      found(ops.getThread(db, id), THREAD_NOT_FOUND)
      const records = ops.listMessagesByThread(db, id)
      const target = v.id(messageId, 'messageId')
      if (!records.some((m) => m.id === target)) {
        throw new NotFoundError('メッセージが見つかりません。')
      }
      return ops.updateThread(db, id, { active_leaf_id: leafFrom(records, target) })!
    },
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
    'chat:compact': (threadId) => {
      const id = v.id(threadId, 'threadId')
      if (engineForThread(id) !== chatService) {
        throw new ops.ValidationError('Cowork のスレッドは自動で圧縮されるため、要約は不要です。')
      }
      return chatService.compact(id)
    },
    'settings:getGlobalInstructions': () => getGlobalInstructions(db),
    'settings:setGlobalInstructions': (text) => setGlobalInstructions(db, v.str(text, 'text')),
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
    'cowork:listDir': (projectId, relPath) =>
      listDir(workFolderOf(v.id(projectId, 'projectId')), v.str(relPath, 'relPath')),
    'cowork:preview': (projectId, relPath) =>
      readPreview(workFolderOf(v.id(projectId, 'projectId')), v.str(relPath, 'relPath')),
    'cowork:commands': (projectId) => listSlashCommands(workFolderOf(v.id(projectId, 'projectId'))),
    'cowork:skills': (projectId) => {
      const id = v.id(projectId, 'projectId')
      return skillsStatus(db, id, workFolderOf(id))
    },
    'cowork:trustSkills': (projectId, trust) => {
      const id = v.id(projectId, 'projectId')
      return setSkillsTrust(db, id, workFolderOf(id), v.bool(trust, 'trust'))
    },
    'cowork:mcpList': (projectId) => {
      const id = v.id(projectId, 'projectId')
      workFolderOf(id)
      return mcp.summaries(id)
    },
    'cowork:mcpUpsert': (projectId, server) => {
      const id = v.id(projectId, 'projectId')
      workFolderOf(id)
      return mcp.upsert(id, v.mcpServer(server, 'server'))
    },
    'cowork:mcpRemove': (projectId, name) => {
      const id = v.id(projectId, 'projectId')
      workFolderOf(id)
      return mcp.remove(id, v.str(name, 'name'))
    },
    'cowork:getSettings': (projectId) => {
      const id = v.id(projectId, 'projectId')
      workFolderOf(id)
      return getCoworkSettings(db, id)
    },
    'cowork:setSettings': (projectId, input) => {
      const id = v.id(projectId, 'projectId')
      workFolderOf(id)
      return setCoworkSettings(db, id, v.coworkSettingsInput(input, 'input'))
    },
    'cowork:getPrefs': () => coworkService.getPrefs(),
    'cowork:setPrefs': (input) => coworkService.setPrefs(v.coworkPrefsInput(input, 'input')),

    'usage:status': (projectId) => usage.status(v.optional(v.id)(projectId, 'projectId')),
    'usage:summary': (m) => usage.summary(v.optional(v.month)(m, 'month')),
    'usage:threadTotals': (threadId) => usage.threadTotals(v.id(threadId, 'threadId')),
    'usage:context': (threadId) => {
      const { tokens, model } = usage.contextOf(v.id(threadId, 'threadId'))
      const limit = model ? (modelService.getModelInfo(model)?.max_input_tokens ?? null) : null
      return { tokens, model, limit }
    },
    'usage:getLimits': () => usage.getLimits(),
    'usage:setLimits': (input) => usage.setLimits(v.usageLimitsInput(input, 'input')),
    'usage:setProjectLimit': (projectId, value) => {
      const id = v.id(projectId, 'projectId')
      found(ops.getProject(db, id), PROJECT_NOT_FOUND)
      usage.setProjectLimit(id, v.limit(value, 'limit'))
    },

    'search:query': (query) => search(db, v.searchQuery(query, 'query')),

    'export:project': async (projectId) => {
      const id = v.id(projectId, 'projectId')
      const bundle = exportProject(db, attachments, id)
      return saveFile(`${safeName(bundle.project.name)}.lumina.json`, JSON.stringify(bundle))
    },
    'export:threadMarkdown': async (threadId) => {
      const id = v.id(threadId, 'threadId')
      const thread = found(ops.getThread(db, id), THREAD_NOT_FOUND)
      return saveFile(`${safeName(thread.title ?? 'thread')}.md`, threadToMarkdown(db, id))
    },
    'import:select': async () => {
      const text = await openTextFile([{ name: 'Lumina Code の書き出し', extensions: ['json'] }])
      if (text === null) return null
      const bundle = parseBundle(text)
      const token = randomUUID()
      pendingImports.clear()
      pendingImports.set(token, bundle)
      return previewBundle(bundle, token)
    },
    'import:confirm': (token, workFolder) => {
      const bundle = pendingImports.get(v.id(token, 'token'))
      if (!bundle) throw new ops.ValidationError('読み込むファイルをもう一度選んでください。')
      const folder = v.optional(v.str)(workFolder ?? undefined, 'workFolder')
      // EXP-05: Cowork は作業フォルダを再指定する（PRJ-05 の検証を通す）
      const checked =
        bundle.project.type === 'cowork' && folder
          ? validateWorkFolder(folder, workFolderPolicy)
          : null
      const project = importBundle(db, attachments, bundle, checked)
      pendingImports.delete(token as string)
      return project
    },
    'backup:now': () => backupNow(db, backupDir),
    'backup:list': () => listBackups(backupDir),

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
    'logs:clearAppLog': () => {
      clearAppLog(appInfo.logPath)
      console.info('[app] app log cleared')
    },

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
