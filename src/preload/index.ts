import { contextBridge, ipcRenderer } from 'electron'
import type { IpcArgs, IpcChannel, IpcResult, IpcReturn, LuminaApi } from '@shared/ipc'

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
    getLastOpened: invoke('threads:getLastOpened')
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
  }
}

contextBridge.exposeInMainWorld('lumina', api)
