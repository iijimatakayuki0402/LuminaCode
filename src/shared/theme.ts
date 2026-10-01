// 要件定義書 10.3.1 のデザイン設定。値は参考値で、デザイン時に調整する。
export const ACCENTS = ['purple', 'cyan', 'red'] as const
export type Accent = (typeof ACCENTS)[number]

export const MODES = ['dark', 'light', 'system'] as const
export type Mode = (typeof MODES)[number]

export const DEFAULT_ACCENT: Accent = 'cyan'
export const DEFAULT_MODE: Mode = 'system'
