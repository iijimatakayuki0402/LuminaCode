import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

// 要件 5.3: データ保存先を %APPDATA%\LuminaCode\ に固定する（既定はパッケージ名で決まるため明示する）
// userData を参照する処理（DB 等）より前、ready 前に設定する必要がある
app.setPath('userData', join(app.getPath('appData'), 'LuminaCode'))

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

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
