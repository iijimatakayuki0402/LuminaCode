/**
 * チャットの設定
 *   CHT-09: 送信は Enter が既定。Ctrl+Enter に変更できる
 *   CHT-16: 拒否されたときのフォールバック。既定はオン
 */

import type Database from 'better-sqlite3'
import type { ChatPrefs } from '@shared/types'
import { getSetting, setSetting } from '../db/operations'

const SEND_KEY = 'chat.sendKey'
const FALLBACK_KEY = 'chat.fallback'

export function getChatPrefs(db: Database.Database): ChatPrefs {
  return {
    sendKey: getSetting(db, SEND_KEY) === 'ctrl_enter' ? 'ctrl_enter' : 'enter',
    fallback: getSetting(db, FALLBACK_KEY) !== 'off'
  }
}

export function setChatPrefs(db: Database.Database, input: Partial<ChatPrefs>): ChatPrefs {
  if (input.sendKey) setSetting(db, SEND_KEY, input.sendKey)
  if (input.fallback !== undefined) setSetting(db, FALLBACK_KEY, input.fallback ? 'on' : 'off')
  return getChatPrefs(db)
}
