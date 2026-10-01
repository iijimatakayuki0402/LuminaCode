import { contextBridge } from 'electron'

// レンダラーに公開する API は、ここで最小限に定義する（API キーやファイルには直接触れさせない）
contextBridge.exposeInMainWorld('lumina', {
  versions: { electron: process.versions.electron, chrome: process.versions.chrome }
})
