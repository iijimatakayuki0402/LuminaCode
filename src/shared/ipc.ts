/**
 * main ⇔ renderer の IPC 契約（要件 SEC-32: renderer は preload 経由でのみ main に依頼する）
 * チャンネルごとの引数と戻り値の型をここで一元定義し、main・preload・renderer で共有する。
 */

import type {
  AlwaysAllowRules,
  ApiErrorKind,
  ApiKeyStatus,
  BackupInfo,
  BookmarkRow,
  ImportPreview,
  SearchHit,
  SearchQuery,
  Appearance,
  ChatEvent,
  ChatPrefs,
  ContextUsage,
  CoworkProjectSettings,
  FileEntry,
  FilePreview,
  McpServer,
  McpServerSummary,
  SkillsStatus,
  SlashCommand,
  CoworkPrefs,
  EditAndResendInput,
  FileChange,
  FileDiff,
  CreateProjectInput,
  CreateThreadInput,
  ListProjectsOptions,
  Message,
  ModelList,
  PermissionRequest,
  PermissionResponse,
  Project,
  SendMessageInput,
  SendResult,
  StageResult,
  Thread,
  LicenseList,
  UpdateStatus,
  ToolEventFilter,
  ToolEventInfo,
  ToolEventRow,
  TrashEntry,
  UndoResult,
  UsageLimits,
  UsageStatus,
  UsageSummary,
  UsageTotals,
  UpdateProjectInput,
  UpdateThreadInput,
  CoworkFolder,
  CoworkFolderAccess,
  FullBackupPreview,
  GitStatus,
  ProjectTemplate,
  Snippet,
  SnippetInput
} from './types'

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  /** データ保存先（要件 6.12 の設定画面で表示する） */
  dataPath: string
  /** 単価表（USG-05） */
  pricingPath: string
  /** アプリログ（6.14） */
  logPath: string
  /** DB のバックアップ（10.2） */
  backupPath: string
}

export interface IpcContract {
  'app:getInfo': { args: []; result: AppInfo }
  /** 同梱しているオープンソースのライセンス（6.12） */
  'app:licenses': { args: []; result: LicenseList }
  /** 最後に開いていたプロジェクト（CMN-05）。削除・アーカイブ済みなら null */
  'app:getLastProject': { args: []; result: Project | null }
  /** プロジェクトを開いたとき／ダッシュボードに戻ったとき（null）に記録する */
  'app:setLastProject': { args: [projectId: string | null]; result: void }

  /** 更新（CMN-03）。ダウンロード・インストールは、ユーザーの操作でのみ行う */
  'update:getStatus': { args: []; result: UpdateStatus }
  'update:check': { args: []; result: UpdateStatus }
  'update:download': { args: []; result: UpdateStatus }
  /** アプリを終了して更新をインストールする */
  'update:install': { args: []; result: void }

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
  'threads:get': { args: [id: string]; result: Thread }
  /** 表示する分岐を切り替える（CHT-06）。指定したメッセージから最も新しい子を辿った末端を表示する */
  'threads:setActiveLeaf': { args: [threadId: string, messageId: string]; result: Thread }

  'messages:listByThread': { args: [threadId: string]; result: Message[] }
  /** 回答のブックマークを付け外しする（BMK-01） */
  'messages:setBookmark': { args: [messageId: string, on: boolean]; result: void }
  /** ブックマークの一覧（BMK-02）。projectId で絞り込める */
  'bookmarks:list': { args: [projectId?: string]; result: BookmarkRow[] }

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
  /** これまでの会話を要約し、要約を引き継いだ新しいスレッドを作る（CTX-02） */
  'chat:compact': { args: [threadId: string]; result: Thread }

  /** 全プロジェクト共通のカスタム指示（PRJ-08） */
  'settings:getGlobalInstructions': { args: []; result: string }
  'settings:setGlobalInstructions': { args: [text: string]; result: string }
  /** スニペット（CHT-12）。保存・削除は更新後の一覧を返す */
  'snippets:list': { args: []; result: Snippet[] }
  'snippets:save': { args: [input: SnippetInput]; result: Snippet[] }
  'snippets:delete': { args: [id: string]; result: Snippet[] }
  /** プロジェクトのテンプレート（PRJ-09）。保存・削除は更新後の一覧を返す */
  'templates:list': { args: []; result: ProjectTemplate[] }
  'templates:saveFromProject': {
    args: [projectId: string, name: string]
    result: ProjectTemplate[]
  }
  'templates:delete': { args: [id: string]; result: ProjectTemplate[] }

  /** Cowork: 確認ダイアログへの回答 */
  'cowork:respond': { args: [requestId: string, response: PermissionResponse]; result: void }
  'cowork:toolEvents': { args: [threadId: string]; result: ToolEventInfo[] }
  /** Cowork: 回答待ちの確認（スレッドを開き直したときに表示し直す） */
  'cowork:pendingPermissions': { args: [threadId: string]; result: PermissionRequest[] }
  /** 追加の作業フォルダ（COW-12）。変更は更新後の一覧を返す */
  'cowork:folders': { args: [projectId: string]; result: CoworkFolder[] }
  'cowork:addFolder': {
    args: [projectId: string, path: string, access: CoworkFolderAccess]
    result: CoworkFolder[]
  }
  'cowork:setFolderAccess': {
    args: [projectId: string, path: string, access: CoworkFolderAccess]
    result: CoworkFolder[]
  }
  'cowork:removeFolder': { args: [projectId: string, path: string]; result: CoworkFolder[] }
  /** Git のスナップショット（COW-10） */
  'cowork:gitStatus': { args: [projectId: string]; result: GitStatus }
  'cowork:gitDiff': { args: [projectId: string, ref: string]; result: string }
  /** スナップショットの状態に戻す（戻す前の状態も記録する。増えたファイルは .lumina-trash へ） */
  'cowork:gitRestore': { args: [projectId: string, ref: string]; result: { trashed: number } }
  /** Cowork: 実行（応答メッセージ）単位の変更の一覧と一括 Undo（SEC-15） */
  'cowork:changes': { args: [messageId: string]; result: FileChange[] }
  'cowork:undo': { args: [messageId: string]; result: UndoResult }
  'cowork:diff': { args: [snapshotId: string]; result: FileDiff | null }
  /** Cowork: 退避先（SEC-11） */
  'cowork:trashList': { args: [projectId: string]; result: TrashEntry[] }
  'cowork:trashRestore': {
    args: [projectId: string, entryId: string, root?: string]
    result: string
  }
  'cowork:trashPurge': { args: [projectId: string, olderThanDays: number]; result: number }
  /** Cowork: 常に許可（6.7: 設定画面から解除できる） */
  'cowork:getAlways': { args: [projectId: string, threadId?: string]; result: AlwaysAllowRules }
  'cowork:clearAlways': { args: [scope: 'thread' | 'project', id: string]; result: void }
  /** Cowork: 作業フォルダのファイルツリーとプレビュー（COW-08。読み取り専用） */
  'cowork:listDir': { args: [projectId: string, relPath: string]; result: FileEntry[] }
  'cowork:preview': { args: [projectId: string, relPath: string]; result: FilePreview }
  /** Cowork: 拡張（6.6） */
  'cowork:commands': { args: [projectId: string]; result: SlashCommand[] }
  'cowork:skills': { args: [projectId: string]; result: SkillsStatus }
  'cowork:trustSkills': { args: [projectId: string, trust: boolean]; result: SkillsStatus }
  'cowork:mcpList': { args: [projectId: string]; result: McpServerSummary[] }
  /** 画面で信頼の確認を経てから呼ぶ */
  'cowork:mcpUpsert': { args: [projectId: string, server: McpServer]; result: McpServerSummary[] }
  'cowork:mcpRemove': { args: [projectId: string, name: string]; result: McpServerSummary[] }
  'cowork:getSettings': { args: [projectId: string]; result: CoworkProjectSettings }
  'cowork:setSettings': {
    args: [projectId: string, input: Partial<CoworkProjectSettings>]
    result: CoworkProjectSettings
  }
  /** Cowork: コマンドの拒否リスト・許可リスト（SEC-22、SEC-23） */
  'cowork:getPrefs': { args: []; result: CoworkPrefs }
  'cowork:setPrefs': { args: [input: Partial<CoworkPrefs>]; result: CoworkPrefs }

  /** 使用量（USG-01〜05） */
  'usage:status': { args: [projectId?: string]; result: UsageStatus }
  'usage:summary': { args: [month?: string]; result: UsageSummary }
  /** 利用履歴を CSV で書き出す（USG-06。month を省略すると全期間。キャンセル時は null） */
  'usage:exportCsv': { args: [month?: string]; result: string | null }
  'usage:threadTotals': { args: [threadId: string]; result: UsageTotals }
  /** スレッドのコンテキスト使用量（CTX-01） */
  'usage:context': { args: [threadId: string]; result: ContextUsage }
  'usage:getLimits': { args: []; result: UsageLimits }
  'usage:setLimits': { args: [input: Partial<UsageLimits>]; result: UsageLimits }
  'usage:setProjectLimit': { args: [projectId: string, limit: number | null]; result: void }

  /** 横断検索（SRC-01、SRC-02） */
  'search:query': { args: [query: SearchQuery]; result: SearchHit[] }

  /** 書き出し（EXP-01、EXP-02）。保存先を選んで書き出す（キャンセル時は null） */
  'export:project': { args: [projectId: string]; result: string | null }
  'export:threadMarkdown': { args: [threadId: string]; result: string | null }
  /** 読み込み（EXP-01）。ファイルを選んで内容を確認する（キャンセル時は null） */
  'import:select': { args: []; result: ImportPreview | null }
  /** 確認した内容で読み込む。Cowork は作業フォルダの指定が必須（EXP-05） */
  'import:confirm': { args: [token: string, workFolder: string | null]; result: Project }

  /** DB のバックアップ（10.2） */
  'backup:now': { args: []; result: BackupInfo }
  'backup:list': { args: []; result: BackupInfo[] }
  /** 全データのバックアップ（EXP-03）。保存先のフォルダを選ぶ（キャンセル時は null） */
  'fullBackup:create': { args: []; result: string | null }
  /** 復元するバックアップのフォルダを選び、内容を確かめる（キャンセル時は null） */
  'fullBackup:select': { args: []; result: FullBackupPreview | null }
  /** 復元を予約してアプリを再起動する */
  'fullBackup:restore': { args: [path: string]; result: void }

  /** 操作ログ（LOG-02、LOG-03） */
  'logs:search': { args: [filter: ToolEventFilter]; result: ToolEventRow[] }
  /** 保存先を選んで書き出す（キャンセル時は null） */
  'logs:export': { args: [filter: ToolEventFilter, format: 'csv' | 'json']; result: string | null }
  'logs:deleteBefore': { args: [before: number]; result: number }
  /** アプリログを削除する（6.12） */
  'logs:clearAppLog': { args: []; result: void }

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
    licenses: Invoke<'app:licenses'>
    getLastProject: Invoke<'app:getLastProject'>
    setLastProject: Invoke<'app:setLastProject'>
  }
  update: {
    getStatus: Invoke<'update:getStatus'>
    check: Invoke<'update:check'>
    download: Invoke<'update:download'>
    install: Invoke<'update:install'>
    /** 状態の変化を受け取る。戻り値で解除する */
    onStatus: (listener: (status: UpdateStatus) => void) => () => void
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
    get: Invoke<'threads:get'>
    setActiveLeaf: Invoke<'threads:setActiveLeaf'>
  }
  messages: {
    listByThread: Invoke<'messages:listByThread'>
    setBookmark: Invoke<'messages:setBookmark'>
  }
  bookmarks: {
    list: Invoke<'bookmarks:list'>
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
  instructions: {
    get: Invoke<'settings:getGlobalInstructions'>
    set: Invoke<'settings:setGlobalInstructions'>
  }
  snippets: {
    list: Invoke<'snippets:list'>
    save: Invoke<'snippets:save'>
    delete: Invoke<'snippets:delete'>
  }
  templates: {
    list: Invoke<'templates:list'>
    saveFromProject: Invoke<'templates:saveFromProject'>
    delete: Invoke<'templates:delete'>
  }
  chat: {
    send: Invoke<'chat:send'>
    regenerate: Invoke<'chat:regenerate'>
    editAndResend: Invoke<'chat:editAndResend'>
    stop: Invoke<'chat:stop'>
    compact: Invoke<'chat:compact'>
    /** 生成中の通知を受け取る。戻り値で解除する */
    onEvent: (listener: (event: ChatEvent) => void) => () => void
  }
  cowork: {
    respond: Invoke<'cowork:respond'>
    toolEvents: Invoke<'cowork:toolEvents'>
    pendingPermissions: Invoke<'cowork:pendingPermissions'>
    folders: Invoke<'cowork:folders'>
    addFolder: Invoke<'cowork:addFolder'>
    setFolderAccess: Invoke<'cowork:setFolderAccess'>
    removeFolder: Invoke<'cowork:removeFolder'>
    gitStatus: Invoke<'cowork:gitStatus'>
    gitDiff: Invoke<'cowork:gitDiff'>
    gitRestore: Invoke<'cowork:gitRestore'>
    changes: Invoke<'cowork:changes'>
    undo: Invoke<'cowork:undo'>
    diff: Invoke<'cowork:diff'>
    trashList: Invoke<'cowork:trashList'>
    trashRestore: Invoke<'cowork:trashRestore'>
    trashPurge: Invoke<'cowork:trashPurge'>
    getAlways: Invoke<'cowork:getAlways'>
    clearAlways: Invoke<'cowork:clearAlways'>
    getPrefs: Invoke<'cowork:getPrefs'>
    setPrefs: Invoke<'cowork:setPrefs'>
    listDir: Invoke<'cowork:listDir'>
    preview: Invoke<'cowork:preview'>
    commands: Invoke<'cowork:commands'>
    skills: Invoke<'cowork:skills'>
    trustSkills: Invoke<'cowork:trustSkills'>
    mcpList: Invoke<'cowork:mcpList'>
    mcpUpsert: Invoke<'cowork:mcpUpsert'>
    mcpRemove: Invoke<'cowork:mcpRemove'>
    getSettings: Invoke<'cowork:getSettings'>
    setSettings: Invoke<'cowork:setSettings'>
  }
  usage: {
    status: Invoke<'usage:status'>
    summary: Invoke<'usage:summary'>
    exportCsv: Invoke<'usage:exportCsv'>
    threadTotals: Invoke<'usage:threadTotals'>
    context: Invoke<'usage:context'>
    getLimits: Invoke<'usage:getLimits'>
    setLimits: Invoke<'usage:setLimits'>
    setProjectLimit: Invoke<'usage:setProjectLimit'>
  }
  search: {
    query: Invoke<'search:query'>
  }
  data: {
    exportProject: Invoke<'export:project'>
    exportThreadMarkdown: Invoke<'export:threadMarkdown'>
    importSelect: Invoke<'import:select'>
    importConfirm: Invoke<'import:confirm'>
    backupNow: Invoke<'backup:now'>
    backupList: Invoke<'backup:list'>
    fullBackupCreate: Invoke<'fullBackup:create'>
    fullBackupSelect: Invoke<'fullBackup:select'>
    fullBackupRestore: Invoke<'fullBackup:restore'>
  }
  logs: {
    search: Invoke<'logs:search'>
    export: Invoke<'logs:export'>
    deleteBefore: Invoke<'logs:deleteBefore'>
    clearAppLog: Invoke<'logs:clearAppLog'>
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
export const UPDATE_EVENT_CHANNEL = 'update:status'
