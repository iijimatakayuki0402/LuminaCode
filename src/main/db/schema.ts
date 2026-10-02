/**
 * データベーススキーマ定義
 * SQLiteテーブル構造と初期化クエリ
 */

/**
 * プロジェクト（通常チャット / Cowork）
 */
export const CREATE_PROJECTS_TABLE = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('chat', 'cowork')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  custom_instructions TEXT CHECK(length(custom_instructions) <= 20000),
  work_folder TEXT,
  model TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'confirm_each' CHECK(permission_mode IN ('confirm_each', 'auto_edit', 'plan_only')),
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 要件 PRJ-03: Cowork は作業フォルダ必須、通常チャットは作業フォルダを持たない
  CHECK((type = 'cowork' AND work_folder IS NOT NULL) OR (type = 'chat' AND work_folder IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);
CREATE INDEX IF NOT EXISTS idx_projects_pinned ON projects(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived, updated_at DESC);
`

/**
 * スレッド（会話の単位）
 */
export const CREATE_THREADS_TABLE = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,
  model TEXT,
  extended_thinking INTEGER NOT NULL DEFAULT 0,
  last_opened_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_last_opened ON threads(project_id, last_opened_at DESC);
`

/**
 * メッセージ（会話の内容）
 */
export const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tokens_used INTEGER,
  estimated_cost REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
`

/**
 * 添付ファイル（メッセージに付随）
 */
export const CREATE_ATTACHMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
`

/**
 * ツールイベント（Cowork操作ログ）
 * 要件 LOG-01: 自動許可された操作（読み取り、編集を自動許可モード）も含めてすべて記録する
 * permission_method:
 *   auto                   権限モードにより自動許可
 *   allowed_once           今回だけ許可
 *   allowed_always_thread  このスレッドでは常に許可
 *   allowed_always_project このプロジェクトでは常に許可
 *   denied                 拒否（ユーザー拒否、計画のみモード、作業フォルダ外など）
 */
export const CREATE_TOOL_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  target TEXT,
  command TEXT,
  result TEXT,
  permission_method TEXT NOT NULL CHECK(permission_method IN ('auto', 'allowed_once', 'allowed_always_thread', 'allowed_always_project', 'denied')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_events_thread ON tool_events(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool ON tool_events(tool_name, created_at DESC);
`

/**
 * 使用量記録（トークン数とコスト）
 * 要件 USG-02〜04: 月別集計と上限判定のため、プロジェクト・スレッド削除後も記録を残す。
 * 削除後も表示できるよう、記録時点のプロジェクト名を project_name に保持する。
 */
export const CREATE_USAGE_RECORDS_TABLE = `
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  project_name TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE SET NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_records(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_thread ON usage_records(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_records(created_at DESC);
`

/**
 * 設定（キー・バリューストア）
 * APIキーは別途暗号化領域に保存するため、ここには含めない
 */
export const CREATE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/**
 * スナップショット（Cowork変更前の内容）
 * 内容はアプリのデータ保存先（snapshots 配下）にファイルとして保存し、DB には参照のみを持つ
 * file_path: 変更対象の元ファイル、stored_path: 保存したスナップショットのファイル
 */
export const CREATE_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_thread ON snapshots(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_file ON snapshots(file_path, created_at DESC);
`

/**
 * スキーマバージョン管理テーブル
 */
export const CREATE_SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

/**
 * マイグレーション定義
 * version ごとに適用する SQL。既存 DB にはその version より新しいものだけを順に適用する。
 * 適用済みの SQL は変更せず、スキーマ変更は新しい version を追加して行う。
 */
export interface Migration {
  version: number
  statements: string[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      CREATE_PROJECTS_TABLE,
      CREATE_THREADS_TABLE,
      CREATE_MESSAGES_TABLE,
      CREATE_ATTACHMENTS_TABLE,
      CREATE_TOOL_EVENTS_TABLE,
      CREATE_USAGE_RECORDS_TABLE,
      CREATE_SETTINGS_TABLE,
      CREATE_SNAPSHOTS_TABLE
    ]
  },
  {
    // 通常チャット（Stage 5）: 応答の状態と、API へそのまま送り返す内容ブロック
    //   status:         streaming（生成中）/ complete / stopped（CHT-04）/ error / interrupted（異常終了。6.14）
    //   content_blocks: 応答の内容ブロック（思考ブロックを含む JSON）。完了した応答のみ保持し、
    //                   次のリクエストで変更せずに送り返す（思考ブロックは会話に結び付くため）
    version: 2,
    statements: [
      `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'
         CHECK(status IN ('streaming', 'complete', 'stopped', 'error', 'interrupted'))`,
      'ALTER TABLE messages ADD COLUMN content_blocks TEXT',
      'ALTER TABLE messages ADD COLUMN model TEXT',
      'ALTER TABLE messages ADD COLUMN stop_reason TEXT',
      'ALTER TABLE messages ADD COLUMN error_kind TEXT',
      'CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)'
    ]
  },
  {
    // Cowork（Stage 6）
    //   threads.agent_session_id:   Agent SDK のセッション ID（次の実行で再開する）
    //   messages.agent_resume_uuid: その応答の最後のエントリ（編集・再送信でここまで巻き戻して再開する）
    //   tool_events:                実行（応答メッセージ）単位でまとめ、結果と完了日時を記録する（LOG-01）
    //   snapshots:                  実行単位の一括 Undo のため、種別と退避先を記録する（SEC-14、SEC-15）
    //                               modified: 変更前の内容 / created: 新規作成（Undo で退避）/ trashed: 削除（退避）
    version: 3,
    statements: [
      'ALTER TABLE threads ADD COLUMN agent_session_id TEXT',
      'ALTER TABLE messages ADD COLUMN agent_resume_uuid TEXT',
      'ALTER TABLE tool_events ADD COLUMN message_id TEXT',
      'ALTER TABLE tool_events ADD COLUMN tool_use_id TEXT',
      'ALTER TABLE tool_events ADD COLUMN category TEXT',
      'ALTER TABLE tool_events ADD COLUMN finished_at INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_tool_events_message ON tool_events(message_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_events_use ON tool_events(tool_use_id)',
      'ALTER TABLE snapshots ADD COLUMN message_id TEXT',
      `ALTER TABLE snapshots ADD COLUMN kind TEXT NOT NULL DEFAULT 'modified'
         CHECK(kind IN ('modified', 'created', 'trashed'))`,
      'ALTER TABLE snapshots ADD COLUMN trash_path TEXT',
      'ALTER TABLE snapshots ADD COLUMN restored_at INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_message ON snapshots(message_id)'
    ]
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
