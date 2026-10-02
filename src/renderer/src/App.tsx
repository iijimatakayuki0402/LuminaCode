import { useEffect, useState } from 'react'
import { DEFAULT_ACCENT, DEFAULT_MODE } from '@shared/theme'
import type { ApiKeyStatus, Appearance, Project } from '@shared/types'
import { applyAppearance } from './lib/appearance'
import { unwrap } from './lib/ipc'
import { ja } from './locales/ja'
import { DashboardScreen } from './screens/DashboardScreen'
import { ProjectScreen } from './screens/ProjectScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { SetupScreen } from './screens/SetupScreen'

type Screen =
  | { name: 'setup' }
  | { name: 'dashboard' }
  | { name: 'settings' }
  | { name: 'project'; project: Project }

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null)
  const [appearance, setAppearance] = useState<Appearance>({
    mode: DEFAULT_MODE,
    accent: DEFAULT_ACCENT
  })
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      unwrap(window.lumina.apiKey.getStatus()),
      unwrap(window.lumina.settings.getAppearance())
    ])
      .then(([s, a]) => {
        setStatus(s)
        setAppearance(a)
        // 要件 KEY-02: 初回（未設定）はセットアップ画面から始める
        if (!s.configured) setScreen({ name: 'setup' })
      })
      .catch((e: unknown) => setError((e as Error).message))
  }, [])

  useEffect(() => applyAppearance(appearance), [appearance])

  // 要件 KEY-01: API キーが削除されたら、チャット・Cowork の画面から出る
  const updateStatus = (next: ApiKeyStatus): void => {
    setStatus(next)
    if (!next.configured && screen.name === 'project') setScreen({ name: 'dashboard' })
  }

  if (error) {
    return (
      <main className="screen">
        <p className="message message-error" role="alert">
          {error}
        </p>
      </main>
    )
  }
  if (!status) return <main className="screen muted">{ja.common.loading}</main>

  if (screen.name === 'setup') {
    return (
      <SetupScreen
        status={status}
        onSaved={(s) => {
          setStatus(s)
          setScreen({ name: 'dashboard' })
        }}
        onSkip={() => setScreen({ name: 'dashboard' })}
      />
    )
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">LUMINA CODE</span>
        {/* DSH-02: 設定画面を開くボタン */}
        <nav className="row">
          {screen.name !== 'dashboard' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'dashboard' })}>
              {ja.nav.dashboard}
            </button>
          )}
          {screen.name !== 'settings' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'settings' })}>
              {ja.nav.settings}
            </button>
          )}
        </nav>
      </header>
      {screen.name === 'settings' && (
        <SettingsScreen
          status={status}
          onStatusChange={updateStatus}
          appearance={appearance}
          onAppearanceChange={setAppearance}
        />
      )}
      {screen.name === 'dashboard' && (
        <DashboardScreen
          apiKeyConfigured={status.configured}
          onOpen={(project) => setScreen({ name: 'project', project })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
        />
      )}
      {screen.name === 'project' && (
        <ProjectScreen project={screen.project} onBack={() => setScreen({ name: 'dashboard' })} />
      )}
    </>
  )
}
