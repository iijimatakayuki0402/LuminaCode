import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { CHAT_EVENT_CHANNEL } from '@shared/ipc'
import { createAnthropicClient } from './api/client'
import { AttachmentStore } from './chat/attachments'
import { ChatService } from './chat/chatService'
import { getSnapshotsDir, pruneOrphanSnapshotFiles } from './cowork/snapshot'
import { closeDatabase, DatabaseIntegrityError, getDatabase } from './db/init'
import { getMessage } from './db/operations'
import { createHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { ModelService } from './models/modelService'
import { ApiKeyStore } from './secrets/apiKeyStore'
import { isTrustedSenderUrl, type TrustedOrigin } from './security/ipcSender'

// 要件 5.3: データ保存先を %APPDATA%\LuminaCode\ に固定する（既定はパッケージ名で決まるため明示する）
// userData を参照する処理（DB 等）より前、ready 前に設定する必要がある
// 開発時のみ、検証用に LUMINA_USER_DATA_DIR で切り替えられる（本来のデータを汚さないため）
const devUserData = app.isPackaged ? undefined : process.env['LUMINA_USER_DATA_DIR']
app.setPath('userData', devUserData ?? join(app.getPath('appData'), 'LuminaCode'))

const rendererIndex = join(__dirname, '../renderer/index.html')
const trustedOrigin: TrustedOrigin = {
  devServerUrl: process.env['ELECTRON_RENDERER_URL'],
  rendererFileUrl: pathToFileURL(rendererIndex).href
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 要件 SEC-32: コンテキスト分離の有効化、Node 統合の無効化
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // 外部リンクは既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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

/**
 * DB を開き、IPC を登録する。失敗した場合はメッセージを表示して false を返す
 */
function setupBackend(): boolean {
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

  chatService = new ChatService({
    db,
    attachments,
    modelService,
    getApiKey: () => apiKeyStore.get(),
    createClient: createAnthropicClient,
    emit: (event) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send(CHAT_EVENT_CHANNEL, event)
    }
  })
  // モデル一覧が古い・無い場合は、起動時に裏で更新する（既定モデルの設定にも必要）
  if (apiKeyStore.get() !== null) void modelService.list().catch(() => undefined)

  // 要件 6.14: 前回、生成中のまま終了した応答を「中断」として表示する
  const interrupted = chatService.recoverInterrupted()
  if (interrupted > 0) console.warn(`[startup] marked ${interrupted} message(s) as interrupted`)

  registerIpcHandlers(
    createHandlers({
      db,
      apiKeyStore,
      modelService,
      chatService,
      attachments,
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
        dataPath: app.getPath('userData')
      }
    }),
    (event) => isTrustedSenderUrl(event.senderFrame?.url, trustedOrigin)
  )
  return true
}

void app.whenReady().then(() => {
  if (!setupBackend()) {
    app.quit()
    return
  }

  createWindow()
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
  for (const threadId of chatService.activeThreadIds()) chatService.stop(threadId)
  void Promise.race([chatService.whenIdle(), new Promise((r) => setTimeout(r, 3000))]).then(() =>
    app.quit()
  )
})

app.on('will-quit', () => {
  closeDatabase()
})
