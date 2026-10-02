import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { unwrap } from './lib/ipc'

export default function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [projectCount, setProjectCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([unwrap(window.lumina.app.getInfo()), unwrap(window.lumina.projects.list())])
      .then(([appInfo, projects]) => {
        setInfo(appInfo)
        setProjectCount(projects.length)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <main className="app">
      <h1>Lumina Code</h1>
      {error && <p className="muted">エラー: {error}</p>}
      {info && (
        <p className="muted">
          v{info.version} / Electron {info.electron} / Chrome {info.chrome}
          <br />
          データ保存先: {info.dataPath}
          <br />
          プロジェクト数: {projectCount}
        </p>
      )}
    </main>
  )
}
