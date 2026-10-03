/**
 * IPC 送信元の検証（要件 SEC-32）
 * アプリ自身の画面（開発時は dev サーバー、本番は同梱の index.html）からの呼び出しだけを受け付ける。
 */

export interface TrustedOrigin {
  /** 開発時の renderer URL（ELECTRON_RENDERER_URL） */
  devServerUrl?: string
  /** 本番の renderer の index.html（file: URL） */
  rendererFileUrl: string
}

export function isTrustedSenderUrl(senderUrl: string | undefined, trusted: TrustedOrigin): boolean {
  if (!senderUrl) return false

  let url: URL
  try {
    url = new URL(senderUrl)
  } catch {
    return false
  }

  if (trusted.devServerUrl) {
    return url.origin === new URL(trusted.devServerUrl).origin
  }

  const expected = new URL(trusted.rendererFileUrl)
  return (
    url.protocol === 'file:' &&
    url.host === expected.host &&
    decodeURIComponent(url.pathname).toLowerCase() ===
      decodeURIComponent(expected.pathname).toLowerCase()
  )
}
