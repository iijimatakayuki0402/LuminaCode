/**
 * main ⇔ renderer の IPC 契約（要件 SEC-32: renderer は preload 経由でのみ main に依頼する）
 * チャンネルごとの引数と戻り値の型をここで一元定義し、main・preload・renderer で共有する。
 */

import type {
  ApiKeyStatus,
  CreateProjectInput,
  CreateThreadInput,
  Message,
  ModelList,
  Project,
  Thread,
  UpdateProjectInput,
  UpdateThreadInput
} from './types'

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  /** データ保存先（要件 6.12 の設定画面で表示する） */
  dataPath: string
}

export interface IpcContract {
  'app:getInfo': { args: []; result: AppInfo }

  'projects:list': { args: []; result: Project[] }
  'projects:get': { args: [id: string]; result: Project }
  'projects:create': { args: [input: CreateProjectInput]; result: Project }
  'projects:update': { args: [id: string, input: UpdateProjectInput]; result: Project }
  'projects:delete': { args: [id: string]; result: void }

  'threads:listByProject': { args: [projectId: string]; result: Thread[] }
  'threads:create': { args: [input: CreateThreadInput]; result: Thread }
  'threads:update': { args: [id: string, input: UpdateThreadInput]; result: Thread }
  'threads:delete': { args: [id: string]; result: void }
  'threads:markOpened': { args: [id: string]; result: void }
  'threads:getLastOpened': { args: [projectId: string]; result: Thread | null }

  'messages:listByThread': { args: [threadId: string]; result: Message[] }

  'apiKey:getStatus': { args: []; result: ApiKeyStatus }
  /** 疎通テストに成功した場合のみ保存する（要件 KEY-02） */
  'apiKey:save': { args: [apiKey: string]; result: ApiKeyStatus }
  'apiKey:test': { args: []; result: void }
  'apiKey:delete': { args: []; result: ApiKeyStatus }

  'models:list': { args: [refresh?: boolean]; result: ModelList }
  'models:getDefault': { args: []; result: string | null }
  'models:setDefault': { args: [modelId: string]; result: void }
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args']
export type IpcReturn<C extends IpcChannel> = IpcContract[C]['result']

/**
 * エラー種別
 *   validation        入力値が要件を満たさない（message は画面にそのまま表示できる）
 *   not_found         対象が存在しない
 *   invalid_argument  引数の型・形式が不正（renderer 側の不具合）
 *   forbidden         信頼できない送信元からの呼び出し
 *   api               Anthropic API の呼び出しに失敗（apiKind で種別を示す。要件 6.14）
 *   internal          予期しないエラー（詳細は main のログにのみ出す）
 */
export type IpcErrorCode =
  'validation' | 'not_found' | 'invalid_argument' | 'forbidden' | 'api' | 'internal'

/**
 * API エラーの種別（要件 6.14）
 * auth・permission は API キーの再設定、billing はコンソールの確認を促す
 */
export type ApiErrorKind =
  | 'auth'
  | 'permission'
  | 'billing'
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'offline'
  | 'timeout'
  | 'too_large'
  | 'bad_request'
  | 'not_found'
  | 'unknown'

export interface IpcError {
  code: IpcErrorCode
  message: string
  /** code が 'api' のときの種別 */
  apiKind?: ApiErrorKind
}

/**
 * IPC の戻り値。Error オブジェクトはプロセス間で種別が失われるため、結果を値として返す
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

type Invoke<C extends IpcChannel> = (...args: IpcArgs<C>) => Promise<IpcResult<IpcReturn<C>>>

/**
 * preload が window.lumina として公開する API
 */
export interface LuminaApi {
  app: {
    getInfo: Invoke<'app:getInfo'>
  }
  projects: {
    list: Invoke<'projects:list'>
    get: Invoke<'projects:get'>
    create: Invoke<'projects:create'>
    update: Invoke<'projects:update'>
    delete: Invoke<'projects:delete'>
  }
  threads: {
    listByProject: Invoke<'threads:listByProject'>
    create: Invoke<'threads:create'>
    update: Invoke<'threads:update'>
    delete: Invoke<'threads:delete'>
    markOpened: Invoke<'threads:markOpened'>
    getLastOpened: Invoke<'threads:getLastOpened'>
  }
  messages: {
    listByThread: Invoke<'messages:listByThread'>
  }
  apiKey: {
    getStatus: Invoke<'apiKey:getStatus'>
    save: Invoke<'apiKey:save'>
    test: Invoke<'apiKey:test'>
    delete: Invoke<'apiKey:delete'>
  }
  models: {
    list: Invoke<'models:list'>
    getDefault: Invoke<'models:getDefault'>
    setDefault: Invoke<'models:setDefault'>
  }
}
