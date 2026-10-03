import { useEffect, useState } from 'react'
import { DEFAULT_ACCENT, DEFAULT_MODE } from '@shared/theme'
import type { ApiKeyStatus, Appearance, Project, UpdateStatus } from '@shared/types'
import { applyAppearance } from './lib/appearance'
import { unwrap } from './lib/ipc'
import { useShortcuts } from './lib/useShortcuts'
import { ja } from './locales/ja'
import { DashboardScreen } from './screens/DashboardScreen'
import { OperationLogScreen } from './screens/OperationLogScreen'
import { UsageScreen } from './screens/UsageScreen'
import { SearchScreen } from './screens/SearchScreen'
import { BookmarksScreen } from './screens/BookmarksScreen'
import { ProjectScreen } from './screens/ProjectScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { SetupScreen } from './screens/SetupScreen'

type Screen =
  | { name: 'setup' }
  /** createProject: 新規プロジェクトのダイアログを開いた状態で表示する（Ctrl+Shift+N） */
  | { name: 'dashboard'; createProject?: number }
  /** section: 表示する位置（更新のお知らせから開いたときはアプリ情報） */
  | { name: 'settings'; section?: 'about' }
  | { name: 'logs' }
  | { name: 'usage' }
  | { name: 'project'; project: Project; focus?: { threadId: string; messageId: string } }
  /** focus: Ctrl+K で開き直したときに検索欄へフォーカスを戻す */
  | { name: 'search'; focus?: number }
  /** BMK-02: ブックマークの一覧 */
  | { name: 'bookmarks' }

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null)
  const [appearance, setAppearance] = useState<Appearance>({
    mode: DEFAULT_MODE,
    accent: DEFAULT_ACCENT
  })
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' })
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  // CMN-03: 更新の状態（起動時の確認結果も、ここで受け取って表示する）
  useEffect(() => {
    const off = window.lumina.update.onStatus(setUpdate)
    void window.lumina.update.getStatus().then((r) => r.ok && setUpdate(r.value))
    return off
  }, [])

  // CMN-02: 画面をまたぐショートカット（新規スレッドはプロジェクト画面で受け取る）
  useShortcuts({
    newProject: () => setScreen({ name: 'dashboard', createProject: Date.now() }),
    search: () => setScreen({ name: 'search', focus: Date.now() }),
    settings: () => setScreen({ name: 'settings' })
  })

  // CMN-05: 起動時の画面を決めるまでは、開いたプロジェクトを記録しない
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    Promise.all([
      unwrap(window.lumina.apiKey.getStatus()),
      unwrap(window.lumina.settings.getAppearance()),
      unwrap(window.lumina.app.getLastProject())
    ])
      .then(([s, a, last]) => {
        setStatus(s)
        setAppearance(a)
        // 要件 KEY-02: 初回（未設定）はセットアップ画面から始める
        if (!s.configured) setScreen({ name: 'setup' })
        // CMN-05: 最後に開いていたプロジェクトを開く
        else if (last) setScreen({ name: 'project', project: last })
        setRestored(true)
      })
      .catch((e: unknown) => setError((e as Error).message))
  }, [])

  // CMN-05: プロジェクトを開いたら記録し、ダッシュボードに戻ったら消す
  const lastProjectId =
    screen.name === 'project' ? screen.project.id : screen.name === 'dashboard' ? null : undefined
  useEffect(() => {
    if (restored && lastProjectId !== undefined) {
      void window.lumina.app.setLastProject(lastProjectId)
    }
  }, [restored, lastProjectId])

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
        <span className="row">
          <span className="brand">LUMINA CODE</span>
          {(update?.state === 'available' || update?.state === 'downloaded') && update.version && (
            <button
              className="btn btn-sm update-badge"
              type="button"
              onClick={() => setScreen({ name: 'settings', section: 'about' })}
            >
              {update.state === 'downloaded'
                ? ja.update.bannerReady(update.version)
                : ja.update.banner(update.version)}
            </button>
          )}
        </span>
        {/* DSH-02: 設定画面を開くボタン */}
        <nav className="row">
          {screen.name !== 'dashboard' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'dashboard' })}>
              {ja.nav.dashboard}
            </button>
          )}
          {screen.name !== 'search' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'search' })}>
              {ja.search.nav}
            </button>
          )}
          {screen.name !== 'bookmarks' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'bookmarks' })}>
              {ja.bookmarks.nav}
            </button>
          )}
          {screen.name !== 'usage' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'usage' })}>
              {ja.usage.nav}
            </button>
          )}
          {screen.name !== 'logs' && (
            <button className="btn" type="button" onClick={() => setScreen({ name: 'logs' })}>
              {ja.logs.nav}
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
          key={screen.section ?? ''}
          section={screen.section}
          update={update}
          status={status}
          onStatusChange={updateStatus}
          appearance={appearance}
          onAppearanceChange={setAppearance}
          onOpenLogs={() => setScreen({ name: 'logs' })}
        />
      )}
      {screen.name === 'logs' && <OperationLogScreen />}
      {screen.name === 'usage' && <UsageScreen />}
      {screen.name === 'search' && (
        <SearchScreen
          focus={screen.focus}
          onOpen={(hit) => {
            // KEY-01: API キーが未設定の間はチャット・Cowork の画面を開かない
            if (!status.configured) {
              setScreen({ name: 'settings' })
              return
            }
            void unwrap(window.lumina.projects.get(hit.project_id)).then((project) =>
              setScreen({
                name: 'project',
                project,
                focus: { threadId: hit.thread_id, messageId: hit.message_id }
              })
            )
          }}
        />
      )}
      {screen.name === 'bookmarks' && (
        <BookmarksScreen
          onOpen={(bookmark) => {
            // KEY-01: API キーが未設定の間はチャット・Cowork の画面を開かない
            if (!status.configured) {
              setScreen({ name: 'settings' })
              return
            }
            // BMK-03: スレッドの該当メッセージへ移動する（SRC-01 と同じ）
            void unwrap(window.lumina.projects.get(bookmark.project_id)).then((project) =>
              setScreen({
                name: 'project',
                project,
                focus: { threadId: bookmark.thread_id, messageId: bookmark.message_id }
              })
            )
          }}
        />
      )}
      {screen.name === 'dashboard' && (
        <DashboardScreen
          key={screen.createProject ?? ''}
          openCreate={screen.createProject !== undefined}
          apiKeyConfigured={status.configured}
          onOpen={(project) => setScreen({ name: 'project', project })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
        />
      )}
      {screen.name === 'project' && (
        <ProjectScreen
          key={`${screen.project.id}-${screen.focus?.messageId ?? ''}`}
          project={screen.project}
          focus={screen.focus}
          onBack={() => setScreen({ name: 'dashboard' })}
        />
      )}
    </>
  )
}
