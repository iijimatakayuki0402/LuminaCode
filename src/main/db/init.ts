/**
 * データベース初期化
 * SQLiteデータベースの作成、整合性確認、マイグレーション
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CREATE_SCHEMA_VERSION_TABLE, MIGRATIONS, SCHEMA_VERSION } from './schema'

let db: Database.Database | null = null

/**
 * 起動時の整合性確認に失敗した場合のエラー
 * 要件 10.2: 呼び出し側でバックアップからの復元などを案内する
 */
export class DatabaseIntegrityError extends Error {
  constructor(public readonly details: string[]) {
    super('データベースの整合性確認に失敗しました')
    this.name = 'DatabaseIntegrityError'
  }
}

/**
 * データベースファイルのパスを取得
 * %APPDATA%\LuminaCode\lumina.db（userData は main/index.ts で設定）
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
  db = openDatabase(getDatabasePath())
  return db
}

/**
 * データベースを開き、整合性確認とスキーマ初期化を行う
 */
export function openDatabase(filename: string): Database.Database {
  const database = new Database(filename)
  try {
    // WALモードを有効化（パフォーマンス向上、並行読み取り可能）
    database.pragma('journal_mode = WAL')
    // 外部キー制約を有効化
    database.pragma('foreign_keys = ON')

    checkIntegrity(database)
    initializeSchema(database)
  } catch (error) {
    database.close()
    throw error
  }
  return database
}

/**
 * 整合性確認（要件 10.2）
 */
function checkIntegrity(database: Database.Database): void {
  const rows = database.pragma('quick_check') as { quick_check: string }[]
  const results = rows.map((row) => row.quick_check)
  if (results.length !== 1 || results[0] !== 'ok') {
    throw new DatabaseIntegrityError(results)
  }
}

/**
 * スキーマを初期化（未適用のマイグレーションを順に適用）
 */
export function initializeSchema(database: Database.Database): void {
  database.exec(CREATE_SCHEMA_VERSION_TABLE)

  const row = database
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined

  const currentVersion = row?.version ?? 0

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `データベースのスキーマ（version ${currentVersion}）がアプリ（version ${SCHEMA_VERSION}）より新しいため開けません`
    )
  }

  const recordVersion = database.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
  )

  // version ごとに、SQL の適用とバージョン記録を 1 つのトランザクションで行う
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue

    database.transaction(() => {
      for (const sql of migration.statements) {
        database.exec(sql)
      }
      recordVersion.run(migration.version, Date.now())
    })()
  }
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
  return openDatabase(':memory:')
}
