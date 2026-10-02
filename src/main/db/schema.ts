/**
 * データベーススキーマ定義
 * SQLiteテーブル構造と初期化クエリ
 */

export const SCHEMA_VERSION = 1

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
  permission_mode TEXT CHECK(permission_mode IN ('confirm_each', 'auto_edit', 'plan_only')) DEFAULT 'confirm_each',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, updated_at DESC);
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
 */
export const CREATE_TOOL_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  target TEXT,
  command TEXT,
  result TEXT,
  permission_method TEXT CHECK(permission_method IN ('allowed_once', 'allowed_always', 'denied')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_events_thread ON tool_events(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool ON tool_events(tool_name, created_at DESC);
`

/**
 * 使用量記録（トークン数とコスト）
 */
export const CREATE_USAGE_RECORDS_TABLE = `
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  thread_id TEXT,
  message_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
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
 */
export const CREATE_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content BLOB NOT NULL,
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
 * すべてのテーブル作成SQLの配列
 */
export const ALL_TABLE_DEFINITIONS = [
  CREATE_SCHEMA_VERSION_TABLE,
  CREATE_PROJECTS_TABLE,
  CREATE_THREADS_TABLE,
  CREATE_MESSAGES_TABLE,
  CREATE_ATTACHMENTS_TABLE,
  CREATE_TOOL_EVENTS_TABLE,
  CREATE_USAGE_RECORDS_TABLE,
  CREATE_SETTINGS_TABLE,
  CREATE_SNAPSHOTS_TABLE
]
