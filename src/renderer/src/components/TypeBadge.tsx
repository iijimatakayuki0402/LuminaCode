import type { ProjectType } from '@shared/types'
import { ja } from '../locales/ja'

/**
 * 種別のアイコン（要件 DSH-04: 通常チャット＝吹き出し、Cowork＝フォルダ＋ターミナル）
 */
export function TypeIcon({ type }: { type: ProjectType }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {type === 'chat' ? (
        <path
          d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <path
            d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="M4.5 7.5 6.5 9l-2 1.5M8 10.5h3"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  )
}

/**
 * 種別バッジ（色・アイコン・ラベルを併記する。要件 DSH-03、DSH-04）
 */
export function TypeBadge({ type }: { type: ProjectType }): React.JSX.Element {
  return (
    <span className={`badge type-${type}`}>
      <TypeIcon type={type} />
      {ja.projectType[type]}
    </span>
  )
}
