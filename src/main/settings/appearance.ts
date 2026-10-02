/**
 * 表示設定（要件 CMN-01、CMN-06: 再起動後も保持する）
 */

import type Database from 'better-sqlite3'
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_MODE, MODES } from '@shared/theme'
import type { Appearance } from '@shared/types'
import { getSetting, setSetting } from '../db/operations'

const MODE_KEY = 'appearance.mode'
const ACCENT_KEY = 'appearance.accent'

const pick = <T extends string>(value: string | null, values: readonly T[], fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback

export function getAppearance(db: Database.Database): Appearance {
  return {
    mode: pick(getSetting(db, MODE_KEY), MODES, DEFAULT_MODE),
    accent: pick(getSetting(db, ACCENT_KEY), ACCENTS, DEFAULT_ACCENT)
  }
}

export function setAppearance(db: Database.Database, input: Partial<Appearance>): Appearance {
  db.transaction(() => {
    if (input.mode) setSetting(db, MODE_KEY, input.mode)
    if (input.accent) setSetting(db, ACCENT_KEY, input.accent)
  })()
  return getAppearance(db)
}
