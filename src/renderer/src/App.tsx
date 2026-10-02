import { useEffect, useState } from 'react'
import type { ApiKeyStatus } from '@shared/types'
import { unwrap } from './lib/ipc'
import { ja } from './locales/ja'
import { SettingsScreen } from './screens/SettingsScreen'
import { SetupScreen } from './screens/SetupScreen'

type Screen = 'setup' | 'home' | 'settings'

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null)
  const [screen, setScreen] = useState<Screen>('home')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    unwrap(window.lumina.apiKey.getStatus())
      .then((s) => {
        setStatus(s)
        // 要件 KEY-02: 初回（未設定）はセットアップ画面から始める
        if (!s.configured) setScreen('setup')
      })
      .catch((e: unknown) => setError((e as Error).message))
  }, [])

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

  if (screen === 'setup') {
    return (
      <SetupScreen
        status={status}
        onSaved={(s) => {
          setStatus(s)
          setScreen('home')
        }}
        onSkip={() => setScreen('home')}
      />
    )
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">LUMINA CODE</span>
        <nav className="row">
          <button
            className="btn"
            type="button"
            onClick={() => setScreen(screen === 'settings' ? 'home' : 'settings')}
          >
            {screen === 'settings' ? ja.nav.home : ja.nav.settings}
          </button>
        </nav>
      </header>
      {screen === 'settings' ? (
        <SettingsScreen status={status} onStatusChange={setStatus} />
      ) : (
        <main className="screen">
          {/* 要件 KEY-01: 未設定の間はチャット・Cowork を使えないことを示し、設定画面へ誘導する */}
          {!status.configured && (
            <p className="message message-info">
              {ja.apiKey.requiredNotice}{' '}
              <button className="btn btn-link" type="button" onClick={() => setScreen('settings')}>
                {ja.apiKey.goSettings}
              </button>
            </p>
          )}
          <p className="muted">{ja.home.placeholder}</p>
        </main>
      )}
    </>
  )
}
