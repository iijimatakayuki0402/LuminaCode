import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  CHAT_EVENT_CHANNEL,
  type IpcArgs,
  type IpcChannel,
  type IpcResult,
  type IpcReturn,
  type LuminaApi
} from '@shared/ipc'
import type { ChatEvent } from '@shared/types'

// レンダラーに公開する API は、ここで最小限に定義する（API キーやファイルには直接触れさせない）
// 汎用の invoke は公開せず、用途ごとの関数だけを渡す

const invoke =
  <C extends IpcChannel>(channel: C) =>
  (...args: IpcArgs<C>): Promise<IpcResult<IpcReturn<C>>> =>
    ipcRenderer.invoke(channel, ...args)

const api: LuminaApi = {
  app: {
    getInfo: invoke('app:getInfo')
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
    listByThread: invoke('messages:listByThread')
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
    changes: invoke('cowork:changes'),
    undo: invoke('cowork:undo'),
    diff: invoke('cowork:diff'),
    trashList: invoke('cowork:trashList'),
    trashRestore: invoke('cowork:trashRestore'),
    trashPurge: invoke('cowork:trashPurge'),
    getAlways: invoke('cowork:getAlways'),
    clearAlways: invoke('cowork:clearAlways'),
    getPrefs: invoke('cowork:getPrefs'),
    setPrefs: invoke('cowork:setPrefs')
  },
  usage: {
    status: invoke('usage:status'),
    summary: invoke('usage:summary'),
    threadTotals: invoke('usage:threadTotals'),
    context: invoke('usage:context'),
    getLimits: invoke('usage:getLimits'),
    setLimits: invoke('usage:setLimits'),
    setProjectLimit: invoke('usage:setProjectLimit')
  },
  logs: {
    search: invoke('logs:search'),
    export: invoke('logs:export'),
    deleteBefore: invoke('logs:deleteBefore')
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
