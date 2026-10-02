import type { ApiKeyStatus } from '@shared/types'
import { ApiKeyForm } from '../components/ApiKeyForm'
import { ja } from '../locales/ja'

/**
 * 初回セットアップ（要件 KEY-02）
 */
export function SetupScreen({
  status,
  onSaved,
  onSkip
}: {
  status: ApiKeyStatus
  onSaved: (status: ApiKeyStatus) => void
  onSkip: () => void
}): React.JSX.Element {
  return (
    <main className="screen">
      <h1 className="screen-title">{ja.setup.title}</h1>
      <section className="panel">
        <p>{ja.setup.lead}</p>
        {status.encryptionAvailable ? (
          <ApiKeyForm onSaved={onSaved} />
        ) : (
          <p className="message message-error" role="alert">
            {ja.apiKey.encryptionUnavailable}
          </p>
        )}
      </section>
      <button className="btn btn-link" type="button" onClick={onSkip}>
        {ja.setup.later}
      </button>
    </main>
  )
}
