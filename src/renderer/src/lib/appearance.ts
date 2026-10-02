import type { Appearance } from '@shared/types'

const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

/**
 * 表示モード・アクセントカラーを画面に反映する（要件 CMN-01、CMN-06: 再起動なしで即時に反映）
 * 「標準」は OS の設定に従い、OS 側の変更にも追従する。戻り値で追従を解除する。
 */
export function applyAppearance(appearance: Appearance): () => void {
  const root = document.documentElement
  root.dataset['accent'] = appearance.accent

  const apply = (): void => {
    const dark = appearance.mode === 'dark' || (appearance.mode === 'system' && darkQuery().matches)
    root.dataset['mode'] = dark ? 'dark' : 'light'
  }
  apply()

  if (appearance.mode !== 'system') return () => undefined
  const query = darkQuery()
  query.addEventListener('change', apply)
  return () => query.removeEventListener('change', apply)
}
