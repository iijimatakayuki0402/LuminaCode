import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { createAnthropicClient } from './api/client'
import { getSnapshotsDir, pruneOrphanSnapshotFiles } from './cowork/snapshot'
import { closeDatabase, DatabaseIntegrityError, getDatabase } from './db/init'
import { createHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { ModelService } from './models/modelService'
import { ApiKeyStore } from './secrets/apiKeyStore'
import { isTrustedSenderUrl, type TrustedOrigin } from './security/ipcSender'

// 要件 5.3: データ保存先を %APPDATA%\LuminaCode\ に固定する（既定はパッケージ名で決まるため明示する）
// userData を参照する処理（DB 等）より前、ready 前に設定する必要がある
app.setPath('userData', join(app.getPath('appData'), 'LuminaCode'))

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

  // 要件 5.3: API キーは %APPDATA%\LuminaCode\ 配下に safeStorage（DPAPI）で暗号化して保存する
  const apiKeyStore = new ApiKeyStore(join(app.getPath('userData'), 'api-key.bin'), safeStorage)
  const modelService = new ModelService(db, () => {
    const apiKey = apiKeyStore.get()
    return apiKey === null ? null : createAnthropicClient(apiKey)
  })

  registerIpcHandlers(
    createHandlers({
      db,
      apiKeyStore,
      modelService,
      createClient: createAnthropicClient,
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

app.on('will-quit', () => {
  closeDatabase()
})
