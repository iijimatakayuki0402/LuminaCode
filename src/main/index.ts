import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  safeStorage,
  screen,
  session,
  shell
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHAT_EVENT_CHANNEL, UPDATE_EVENT_CHANNEL } from '@shared/ipc'
import type { ChatEvent, LicenseList } from '@shared/types'
import { createAnthropicClient } from './api/client'
import { AttachmentStore } from './chat/attachments'
import { ChatService } from './chat/chatService'
import { TitleGenerator } from './chat/titleGenerator'
import { getChatPrefs } from './settings/chatPrefs'
import { getGlobalInstructions } from './settings/instructions'
import { CoworkService } from './cowork/coworkService'
import { McpStore } from './cowork/mcpStore'
import { notificationFor } from './notify'
import { getProject, getSetting, getThread, setSetting } from './db/operations'
import { parseWindowState, restoreBounds, WINDOW_STATE_KEY } from './windowState'
import { deleteToolEventsBefore, LOG_RETENTION_DAYS } from './cowork/toolEvents'
import { installAppLog } from './logging/appLog'
import { runDailyBackup } from './data/backup'
import { applyPendingRestore } from './data/fullBackup'
import { getCoworkSettings } from './cowork/extensions'
import { GitSnapshots } from './cowork/gitSnapshot'
import { UsageService } from './usage/usageService'
import { UpdateService } from './update/updateService'
import { getSnapshotsDir, pruneOrphanSnapshotFiles } from './cowork/snapshot'
import { closeDatabase, DatabaseIntegrityError, getDatabase } from './db/init'
import { getMessage } from './db/operations'
import { createHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { ModelService } from './models/modelService'
import { ApiKeyStore } from './secrets/apiKeyStore'
import { isTrustedSenderUrl, type TrustedOrigin } from './security/ipcSender'

// COW-07: Windows のトースト通知に必要
app.setAppUserModelId('com.tiijima.lumina-code')

// 要件 5.3: データ保存先を %APPDATA%\LuminaCode\ に固定する（既定はパッケージ名で決まるため明示する）
// userData を参照する処理（DB 等）より前、ready 前に設定する必要がある
// 開発時のみ、検証用に LUMINA_USER_DATA_DIR で切り替えられる（本来のデータを汚さないため）
const devUserData = app.isPackaged ? undefined : process.env['LUMINA_USER_DATA_DIR']
app.setPath('userData', devUserData ?? join(app.getPath('appData'), 'LuminaCode'))

// 6.14、10.2: エラーなどをローカルのログファイルにも記録する（API キー・会話内容は出さない）
const appLogPath = installAppLog(join(app.getPath('userData'), 'logs'))

const rendererIndex = join(__dirname, '../renderer/index.html')
const trustedOrigin: TrustedOrigin = {
  devServerUrl: process.env['ELECTRON_RENDERER_URL'],
  rendererFileUrl: pathToFileURL(rendererIndex).href
}

function createWindow(): void {
  // CMN-05: 前回の大きさ・位置で開く（モニターの構成が変わって画面外になる場合は中央に開く）
  const db = getDatabase()
  const saved = parseWindowState(getSetting(db, WINDOW_STATE_KEY))
  const win = new BrowserWindow({
    ...restoreBounds(
      saved,
      screen.getAllDisplays().map((d) => d.workArea)
    ),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 要件 SEC-32: コンテキスト分離の有効化、Node 統合の無効化
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => {
    try {
      // 最大化中は、元に戻したときの大きさを保存する
      const state = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
      setSetting(db, WINDOW_STATE_KEY, JSON.stringify(state))
    } catch (error) {
      console.warn('[window] failed to save the window state:', (error as Error).message)
    }
  })

  // 外部リンクは既定ブラウザで開く
  // （file: などを開くとローカルのプログラムが起動しうるため、http(s)・mailto 以外は開かない）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // アプリ画面以外への遷移は許可しない
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedSenderUrl(url, trustedOrigin)) event.preventDefault()
  })

  if (trustedOrigin.devServerUrl) {
    void win.loadURL(trustedOrigin.devServerUrl)
  } else {
    void win.loadFile(rendererIndex)
  }
}

let chatService: ChatService | null = null
let coworkService: CoworkService | null = null
let updateService: UpdateService | null = null

/**
 * 生成中の応答・Cowork の実行を停止し、保存が終わるまで待つ（最大 3 秒。CHT-04）
 */
async function stopAllRuns(): Promise<void> {
  for (const threadId of chatService?.activeThreadIds() ?? []) chatService?.stop(threadId)
  for (const threadId of coworkService?.activeThreadIds() ?? []) coworkService?.stop(threadId)
  await Promise.race([
    Promise.all([chatService?.whenIdle(), coworkService?.whenIdle()]),
    new Promise((r) => setTimeout(r, 3000))
  ])
}

/**
 * 同梱しているオープンソースのライセンス（scripts/generate-licenses.mjs がビルド時に作る）
 */
function readLicenses(): LicenseList {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'licenses.json')
    : join(app.getAppPath(), 'resources', 'licenses.json')
  if (!existsSync(path)) return { appLicense: null, packages: [] }
  return JSON.parse(readFileSync(path, 'utf-8')) as LicenseList
}

/**
 * 更新（CMN-03、10.4）
 * 配信元は electron-builder.yml の publish で設定する（ビルド時に resources\app-update.yml が作られる）。
 * 開発時は、プロジェクト直下に dev-app-update.yml を置いた場合のみ確認できる（インストールはできない）。
 */
function createUpdateService(): UpdateService {
  const devConfig = join(app.getAppPath(), 'dev-app-update.yml')
  const configured = app.isPackaged
    ? existsSync(join(process.resourcesPath, 'app-update.yml'))
    : existsSync(devConfig)
  return new UpdateService({
    configured,
    currentVersion: app.getVersion(),
    createUpdater: () => {
      // Web インストーラーは使わない（通常の NSIS インストーラーで配信する）
      autoUpdater.disableWebInstaller = true
      if (!app.isPackaged) {
        autoUpdater.forceDevUpdateConfig = true
        autoUpdater.updateConfigPath = devConfig
      }
      return autoUpdater
    },
    emit: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(UPDATE_EVENT_CHANNEL, status)
      }
    },
    prepareInstall: stopAllRuns
  })
}

/**
 * 同梱の claude.exe のパス（パッケージ化したアプリでは asar の外に展開されている）
 */
function resolveClaudeExecutable(): string | undefined {
  try {
    const pkg = require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')
    return join(dirname(pkg), 'claude.exe').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  } catch {
    return undefined
  }
}

/**
 * DB を開き、IPC を登録する。失敗した場合はメッセージを表示して false を返す
 */
/** EXP-03: 予約された復元の結果（起動後に知らせる） */
let restoreResult: ReturnType<typeof applyPendingRestore> = { status: 'none' }

function setupBackend(): boolean {
  // EXP-03: 予約された復元は、DB を開く前に行う
  restoreResult = applyPendingRestore(app.getPath('userData'))
  if (restoreResult.status === 'failed') {
    console.error('[restore] failed:', restoreResult.error)
  } else if (restoreResult.status === 'restored') {
    console.info('[restore] restored; previous data kept in', restoreResult.previous)
  }
  let db
  try {
    db = getDatabase()
  } catch (error) {
    console.error('[startup] database open failed:', error)
    dialog.showErrorBox(
      'Lumina Code',
      error instanceof DatabaseIntegrityError
        ? 'データベースが破損している可能性があるため、起動を中止しました。'
        : 'データベースを開けなかったため、起動を中止しました。'
    )
    return false
  }

  try {
    pruneOrphanSnapshotFiles(db, getSnapshotsDir())
  } catch (error) {
    // 掃除の失敗は起動を妨げない
    console.warn('[startup] snapshot cleanup failed:', error)
  }

  // 要件 ATT-04: 添付ファイルはデータ保存先にコピーして保持する
  const attachments = new AttachmentStore(join(app.getPath('userData'), 'attachments'))
  try {
    attachments.clearStaging()
    attachments.pruneOrphans((messageId) => getMessage(db, messageId) !== null)
  } catch (error) {
    console.warn('[startup] attachment cleanup failed:', error)
  }

  // 要件 5.3: API キーは %APPDATA%\LuminaCode\ 配下に safeStorage（DPAPI）で暗号化して保存する
  const apiKeyStore = new ApiKeyStore(join(app.getPath('userData'), 'api-key.bin'), safeStorage)
  const modelService = new ModelService(db, () => {
    const apiKey = apiKeyStore.get()
    return apiKey === null ? null : createAnthropicClient(apiKey)
  })

  // USG-05: 単価表は %APPDATA%\LuminaCode\pricing.json で更新できる
  const usage = new UsageService(db, join(app.getPath('userData'), 'pricing.json'))

  // COW-07: アプリが非アクティブのとき、Cowork の完了・エラー・確認待ちをトースト通知で知らせる
  const notifyIfInactive = (event: ChatEvent): void => {
    if (!Notification.isSupported()) return
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
    const content = notificationFor(event, (threadId) => {
      const thread = getThread(db, threadId)
      const project = thread ? getProject(db, thread.project_id) : null
      return thread && project
        ? {
            projectName: project.name,
            // 最初の発言から作ったタイトルは会話の内容そのものなので、通知には出さない
            threadTitle: thread.title_source === 'auto' ? null : thread.title,
            projectType: project.type
          }
        : null
    })
    if (!content) return
    const notification = new Notification(content)
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.focus()
    })
    notification.show()
  }
  const emitToAll = (event: ChatEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHAT_EVENT_CHANNEL, event)
    notifyIfInactive(event)
  }
  // 6.6: プロジェクトの MCP サーバー（設定は暗号化して保存する）
  const mcp = new McpStore(db, safeStorage)
  // THR-03: スレッドのタイトルを自動生成する
  const titles = new TitleGenerator({
    db,
    modelService,
    getApiKey: () => apiKeyStore.get(),
    createClient: createAnthropicClient,
    usage,
    emit: emitToAll
  })
  const globalInstructions = (): string => getGlobalInstructions(db)

  chatService = new ChatService({
    db,
    usage,
    titles,
    getGlobalInstructions: globalInstructions,
    // CHT-11: Web 検索の設定は Cowork の Web の設定と同じ（プロジェクトごと）
    isWebSearchEnabled: (projectId) => getCoworkSettings(db, projectId).webAccess,
    // CHT-16: 拒否されたときのフォールバック（設定画面でオフにできる）
    isFallbackEnabled: () => getChatPrefs(db).fallback,
    attachments,
    modelService,
    getApiKey: () => apiKeyStore.get(),
    createClient: createAnthropicClient,
    emit: emitToAll
  })
  // モデル一覧が古い・無い場合は、起動時に裏で更新する（既定モデルの設定にも必要）
  if (apiKeyStore.get() !== null) void modelService.list().catch(() => undefined)

  const git = new GitSnapshots()
  coworkService = new CoworkService({
    git,
    db,
    usage,
    mcp,
    pluginsRoot: join(app.getPath('userData'), 'agent', 'plugins'),
    titles,
    getGlobalInstructions: globalInstructions,
    snapshotsDir: getSnapshotsDir(),
    modelService,
    getApiKey: () => apiKeyStore.get(),
    configDir: join(app.getPath('userData'), 'agent'),
    executablePath: app.isPackaged ? resolveClaudeExecutable() : undefined,
    emit: emitToAll
  })

  updateService = createUpdateService()

  // 10.2: DB を日次でバックアップする（直近 7 世代）
  const backupDir = join(app.getPath('userData'), 'backups')
  void runDailyBackup(db, backupDir).catch((error) =>
    console.warn('[startup] backup failed:', (error as Error).message)
  )

  // LOG-03: 保持期間（90 日）を過ぎた操作ログを削除する
  try {
    deleteToolEventsBefore(db, Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  } catch (error) {
    console.warn('[startup] log cleanup failed:', error)
  }

  // 要件 6.14: 前回、生成中のまま終了した応答を「中断」として表示する
  const interrupted = chatService.recoverInterrupted()
  if (interrupted > 0) console.warn(`[startup] marked ${interrupted} message(s) as interrupted`)

  registerIpcHandlers(
    createHandlers({
      db,
      apiKeyStore,
      modelService,
      chatService,
      coworkService,
      git,
      usage,
      mcp,
      attachments,
      saveFile: async (defaultName, content) => {
        const owner = BrowserWindow.getFocusedWindow()
        const options: Electron.SaveDialogOptions = {
          defaultPath: join(app.getPath('documents'), defaultName)
        }
        const result = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return null
        writeFileSync(result.filePath, content, 'utf-8')
        return result.filePath
      },
      openTextFile: async (filters) => {
        const owner = BrowserWindow.getFocusedWindow()
        const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters }
        const result = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options)
        const path = result.canceled ? null : result.filePaths[0]
        if (!path) return null
        // 読み込むファイルの大きさを制限する（添付ファイルを含めて 500MB まで）
        if (statSync(path).size > 500 * 1024 * 1024) {
          throw new Error('ファイルが大きすぎます。')
        }
        return readFileSync(path, 'utf-8')
      },
      backupDir,
      readLicenses,
      update: updateService,
      selectFiles: async () => {
        const owner = BrowserWindow.getFocusedWindow()
        const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
        const result = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options)
        return result.canceled ? [] : result.filePaths
      },
      createClient: createAnthropicClient,
      workFolderPolicy: {
        userDataPath: app.getPath('userData'),
        homeDir: homedir(),
        systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows'
      },
      userData: app.getPath('userData'),
      // EXP-03: 復元は次の起動時に行うため、生成中の応答を保存してから再起動する
      relaunch: async () => {
        await stopAllRuns()
        app.relaunch()
        app.quit()
      },
      selectFolder: async (defaultPath) => {
        const owner = BrowserWindow.getFocusedWindow()
        const options: Electron.OpenDialogOptions = {
          properties: ['openDirectory'],
          defaultPath
        }
        const result = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options)
        return result.canceled ? null : (result.filePaths[0] ?? null)
      },
      appInfo: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        dataPath: app.getPath('userData'),
        pricingPath: usage.pricingFile,
        logPath: appLogPath,
        backupPath: backupDir
      }
    }),
    (event) => isTrustedSenderUrl(event.senderFrame?.url, trustedOrigin)
  )
  return true
}

/** 既定ブラウザ等で開いてよいリンクか */
function isExternalLinkUrl(url: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

// 同じデータを 2 つのプロセスで扱わないよう、2 つ目の起動では既存のウィンドウを前面に出して終了する
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

void app.whenReady().then(() => {
  if (!isPrimaryInstance) return
  // 画面から要求される権限は、コピーボタンが使うクリップボードへの書き込みだけ許可する
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write')
  )
  if (!setupBackend()) {
    app.quit()
    return
  }

  createWindow()
  if (restoreResult.status === 'restored') {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Lumina Code',
      message: 'バックアップからデータを復元しました。',
      detail: `復元前のデータは次の場所に残しています。\n${restoreResult.previous}\n\nAPI キーは復元の対象外です。必要に応じて設定画面で登録してください。`
    })
  } else if (restoreResult.status === 'failed') {
    dialog.showErrorBox(
      'Lumina Code',
      `データを復元できなかったため、今までのデータのまま起動しました。\n${restoreResult.error}`
    )
  }
  // 10.4: 起動時に更新を確認する（起動を遅らせないよう、少し待ってから。配信元が未設定なら何もしない）
  setTimeout(() => void updateService?.check(), 10_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 生成中の応答は停止として保存してから終了する（CHT-04）
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !chatService) return
  quitting = true
  event.preventDefault()
  void stopAllRuns().then(() => app.quit())
})

app.on('will-quit', () => {
  closeDatabase()
})
