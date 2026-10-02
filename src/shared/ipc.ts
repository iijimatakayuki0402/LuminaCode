/**
 * main ⇔ renderer の IPC 契約（要件 SEC-32: renderer は preload 経由でのみ main に依頼する）
 * チャンネルごとの引数と戻り値の型をここで一元定義し、main・preload・renderer で共有する。
 */

import type {
  ApiErrorKind,
  ApiKeyStatus,
  Appearance,
  ChatEvent,
  ChatPrefs,
  EditAndResendInput,
  CreateProjectInput,
  CreateThreadInput,
  ListProjectsOptions,
  Message,
  ModelList,
  Project,
  SendMessageInput,
  SendResult,
  StageResult,
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

  'projects:list': { args: [options?: ListProjectsOptions]; result: Project[] }
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

  'settings:getAppearance': { args: []; result: Appearance }
  'settings:setAppearance': { args: [input: Partial<Appearance>]; result: Appearance }

  'settings:getChatPrefs': { args: []; result: ChatPrefs }
  'settings:setChatPrefs': { args: [input: Partial<ChatPrefs>]; result: ChatPrefs }

  'chat:send': { args: [input: SendMessageInput]; result: SendResult }
  /** 最新のユーザーメッセージに対する応答を作り直す（エラー・停止後の再試行） */
  'chat:regenerate': { args: [userMessageId: string]; result: Message }
  'chat:editAndResend': { args: [input: EditAndResendInput]; result: SendResult }
  'chat:stop': { args: [threadId: string]; result: void }

  /** ファイル選択ダイアログで選び、仮置きする */
  'attachments:select': { args: []; result: StageResult }
  /** ドラッグ＆ドロップしたファイルを仮置きする */
  'attachments:stagePaths': { args: [paths: string[]]; result: StageResult }
  /** 貼り付けた画像を仮置きする */
  'attachments:stageData': { args: [filename: string, data: Uint8Array]; result: StageResult }
  'attachments:discard': { args: [id: string]; result: void }

  /** フォルダ選択ダイアログ（キャンセル時は null） */
  'dialog:selectFolder': { args: [defaultPath?: string]; result: string | null }
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

export type { ApiErrorKind } from './types'

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
  settings: {
    getAppearance: Invoke<'settings:getAppearance'>
    setAppearance: Invoke<'settings:setAppearance'>
  }
  dialog: {
    selectFolder: Invoke<'dialog:selectFolder'>
  }
  chatPrefs: {
    get: Invoke<'settings:getChatPrefs'>
    set: Invoke<'settings:setChatPrefs'>
  }
  chat: {
    send: Invoke<'chat:send'>
    regenerate: Invoke<'chat:regenerate'>
    editAndResend: Invoke<'chat:editAndResend'>
    stop: Invoke<'chat:stop'>
    /** 生成中の通知を受け取る。戻り値で解除する */
    onEvent: (listener: (event: ChatEvent) => void) => () => void
  }
  attachments: {
    select: Invoke<'attachments:select'>
    stagePaths: Invoke<'attachments:stagePaths'>
    stageData: Invoke<'attachments:stageData'>
    discard: Invoke<'attachments:discard'>
    /** ドロップされた File の実パス（preload の webUtils で取得する） */
    pathForFile: (file: File) => string
  }
}

/** main → renderer の通知チャンネル */
export const CHAT_EVENT_CHANNEL = 'chat:event'
