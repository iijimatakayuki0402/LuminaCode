export default function App(): React.JSX.Element {
  const { electron, chrome } = window.lumina.versions
  return (
    <main className="app">
      <h1>Lumina Code</h1>
      <p className="muted">
        開発環境の起動確認用画面です。Electron {electron} / Chrome {chrome}
      </p>
    </main>
  )
}
