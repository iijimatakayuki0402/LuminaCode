/**
 * チャットの入力設定（要件 CHT-09: 送信は Enter が既定。Ctrl+Enter に変更できる）
 */

import type Database from 'better-sqlite3'
import type { ChatPrefs } from '@shared/types'
import { getSetting, setSetting } from '../db/operations'

const SEND_KEY = 'chat.sendKey'

export function getChatPrefs(db: Database.Database): ChatPrefs {
  return { sendKey: getSetting(db, SEND_KEY) === 'ctrl_enter' ? 'ctrl_enter' : 'enter' }
}

export function setChatPrefs(db: Database.Database, input: Partial<ChatPrefs>): ChatPrefs {
  if (input.sendKey) setSetting(db, SEND_KEY, input.sendKey)
  return getChatPrefs(db)
}
