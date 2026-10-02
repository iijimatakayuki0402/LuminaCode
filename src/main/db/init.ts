/**
 * データベース初期化
 * SQLiteデータベースの作成、スキーマ適用、マイグレーション
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_TABLE_DEFINITIONS, SCHEMA_VERSION } from './schema'

let db: Database.Database | null = null

/**
 * データベースファイルのパスを取得
 * %APPDATA%\LuminaCode\lumina.db
 */
export function getDatabasePath(): string {
  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  return join(userDataPath, 'lumina.db')
}

/**
 * データベース接続を取得（シングルトン）
 */
export function getDatabase(): Database.Database {
  if (db) return db

  const dbPath = getDatabasePath()
  db = new Database(dbPath)

  // WALモードを有効化（パフォーマンス向上、並行読み取り可能）
  db.pragma('journal_mode = WAL')
  // 外部キー制約を有効化
  db.pragma('foreign_keys = ON')

  // スキーマ初期化
  initializeSchema(db)

  return db
}

/**
 * スキーマを初期化（テーブル作成とマイグレーション）
 */
function initializeSchema(database: Database.Database): void {
  // すべてのテーブルを作成
  for (const sql of ALL_TABLE_DEFINITIONS) {
    database.exec(sql)
  }

  // 現在のスキーマバージョンを確認
  const row = database
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined

  const currentVersion = row?.version ?? 0

  // 最新バージョンでない場合はマイグレーション実行
  if (currentVersion < SCHEMA_VERSION) {
    runMigrations(database, currentVersion, SCHEMA_VERSION)

    // スキーマバージョンを記録
    database
      .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION, Date.now())
  }
}

/**
 * マイグレーション実行
 * 将来のスキーマ変更時に使用
 */
function runMigrations(database: Database.Database, from: number, to: number): void {
  console.log(`Running migrations from version ${from} to ${to}`)

  // バージョン1への初期化（現時点では何もしない）
  if (from < 1 && to >= 1) {
    // 初期スキーマはすでにCREATE TABLE IF NOT EXISTSで作成済み
  }

  // 将来のマイグレーションはここに追加
  // 例: if (from < 2 && to >= 2) { ... }
}

/**
 * データベース接続を閉じる
 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * テスト用: インメモリデータベースを作成
 */
export function createInMemoryDatabase(): Database.Database {
  const testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')

  for (const sql of ALL_TABLE_DEFINITIONS) {
    testDb.exec(sql)
  }

  testDb
    .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
    .run(SCHEMA_VERSION, Date.now())

  return testDb
}
