import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  CHAT_EVENT_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  type IpcArgs,
  type IpcChannel,
  type IpcResult,
  type IpcReturn,
  type LuminaApi
} from '@shared/ipc'
import type { ChatEvent, UpdateStatus } from '@shared/types'

// レンダラーに公開する API は、ここで最小限に定義する（API キーやファイルには直接触れさせない）
// 汎用の invoke は公開せず、用途ごとの関数だけを渡す

const invoke =
  <C extends IpcChannel>(channel: C) =>
  (...args: IpcArgs<C>): Promise<IpcResult<IpcReturn<C>>> =>
    ipcRenderer.invoke(channel, ...args)

const api: LuminaApi = {
  app: {
    getInfo: invoke('app:getInfo'),
    licenses: invoke('app:licenses'),
    getLastProject: invoke('app:getLastProject'),
    setLastProject: invoke('app:setLastProject')
  },
  update: {
    getStatus: invoke('update:getStatus'),
    check: invoke('update:check'),
    download: invoke('update:download'),
    install: invoke('update:install'),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: UpdateStatus): void =>
        listener(payload)
      ipcRenderer.on(UPDATE_EVENT_CHANNEL, handler)
      return () => ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, handler)
    }
  },
  projects: {
    list: invoke('projects:list'),
    get: invoke('projects:get'),
    create: invoke('projects:create'),
    update: invoke('projects:update'),
    delete: invoke('projects:delete')
  },
  threads: {
    listByProject: invoke('threads:listByProject'),
    create: invoke('threads:create'),
    update: invoke('threads:update'),
    delete: invoke('threads:delete'),
    markOpened: invoke('threads:markOpened'),
    getLastOpened: invoke('threads:getLastOpened'),
    get: invoke('threads:get'),
    setActiveLeaf: invoke('threads:setActiveLeaf')
  },
  messages: {
    listByThread: invoke('messages:listByThread'),
    setBookmark: invoke('messages:setBookmark')
  },
  bookmarks: {
    list: invoke('bookmarks:list')
  },
  apiKey: {
    getStatus: invoke('apiKey:getStatus'),
    save: invoke('apiKey:save'),
    test: invoke('apiKey:test'),
    delete: invoke('apiKey:delete')
  },
  models: {
    list: invoke('models:list'),
    getDefault: invoke('models:getDefault'),
    setDefault: invoke('models:setDefault')
  },
  settings: {
    getAppearance: invoke('settings:getAppearance'),
    setAppearance: invoke('settings:setAppearance')
  },
  dialog: {
    selectFolder: invoke('dialog:selectFolder')
  },
  chatPrefs: {
    get: invoke('settings:getChatPrefs'),
    set: invoke('settings:setChatPrefs')
  },
  instructions: {
    get: invoke('settings:getGlobalInstructions'),
    set: invoke('settings:setGlobalInstructions')
  },
  snippets: {
    list: invoke('snippets:list'),
    save: invoke('snippets:save'),
    delete: invoke('snippets:delete')
  },
  templates: {
    list: invoke('templates:list'),
    saveFromProject: invoke('templates:saveFromProject'),
    delete: invoke('templates:delete')
  },
  chat: {
    send: invoke('chat:send'),
    regenerate: invoke('chat:regenerate'),
    editAndResend: invoke('chat:editAndResend'),
    stop: invoke('chat:stop'),
    compact: invoke('chat:compact'),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ChatEvent): void =>
        listener(payload)
      ipcRenderer.on(CHAT_EVENT_CHANNEL, handler)
      return () => ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, handler)
    }
  },
  cowork: {
    respond: invoke('cowork:respond'),
    toolEvents: invoke('cowork:toolEvents'),
    pendingPermissions: invoke('cowork:pendingPermissions'),
    folders: invoke('cowork:folders'),
    addFolder: invoke('cowork:addFolder'),
    setFolderAccess: invoke('cowork:setFolderAccess'),
    removeFolder: invoke('cowork:removeFolder'),
    gitStatus: invoke('cowork:gitStatus'),
    gitDiff: invoke('cowork:gitDiff'),
    gitRestore: invoke('cowork:gitRestore'),
    changes: invoke('cowork:changes'),
    undo: invoke('cowork:undo'),
    diff: invoke('cowork:diff'),
    trashList: invoke('cowork:trashList'),
    trashRestore: invoke('cowork:trashRestore'),
    trashPurge: invoke('cowork:trashPurge'),
    getAlways: invoke('cowork:getAlways'),
    clearAlways: invoke('cowork:clearAlways'),
    getPrefs: invoke('cowork:getPrefs'),
    setPrefs: invoke('cowork:setPrefs'),
    listDir: invoke('cowork:listDir'),
    preview: invoke('cowork:preview'),
    commands: invoke('cowork:commands'),
    skills: invoke('cowork:skills'),
    trustSkills: invoke('cowork:trustSkills'),
    mcpList: invoke('cowork:mcpList'),
    mcpUpsert: invoke('cowork:mcpUpsert'),
    mcpRemove: invoke('cowork:mcpRemove'),
    getSettings: invoke('cowork:getSettings'),
    setSettings: invoke('cowork:setSettings')
  },
  usage: {
    status: invoke('usage:status'),
    summary: invoke('usage:summary'),
    exportCsv: invoke('usage:exportCsv'),
    threadTotals: invoke('usage:threadTotals'),
    context: invoke('usage:context'),
    getLimits: invoke('usage:getLimits'),
    setLimits: invoke('usage:setLimits'),
    setProjectLimit: invoke('usage:setProjectLimit')
  },
  search: {
    query: invoke('search:query')
  },
  data: {
    exportProject: invoke('export:project'),
    exportThreadMarkdown: invoke('export:threadMarkdown'),
    importSelect: invoke('import:select'),
    importConfirm: invoke('import:confirm'),
    backupNow: invoke('backup:now'),
    backupList: invoke('backup:list'),
    fullBackupCreate: invoke('fullBackup:create'),
    fullBackupSelect: invoke('fullBackup:select'),
    fullBackupRestore: invoke('fullBackup:restore')
  },
  logs: {
    search: invoke('logs:search'),
    export: invoke('logs:export'),
    deleteBefore: invoke('logs:deleteBefore'),
    clearAppLog: invoke('logs:clearAppLog')
  },
  attachments: {
    select: invoke('attachments:select'),
    stagePaths: invoke('attachments:stagePaths'),
    stageData: invoke('attachments:stageData'),
    discard: invoke('attachments:discard'),
    pathForFile: (file) => webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('lumina', api)
