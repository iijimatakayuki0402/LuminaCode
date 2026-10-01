# Phase 0 技術検証結果（Agent SDK の Windows 要件）

| 項目 | 内容 |
|---|---|
| 実施日 | 2026-10-02 |
| 環境 | Windows Server 2025、Node.js 24.19.0、Git for Windows あり |
| 対象 | `@anthropic-ai/claude-agent-sdk` 0.3.286 |
| 検証スクリプト | `scripts/phase0-sdk-check.mjs` |

## 確認できたこと

| # | 内容 | 結果 |
|---|---|---|
| 1 | Windows 用の実行ファイルが同梱されるか | ○ `@anthropic-ai/claude-agent-sdk-win32-x64`（約 245MB の `claude.exe`、Claude Code 2.1.286）が自動で入る。**別途 Claude Code のインストールは不要** |
| 2 | Node から `query()` で起動できるか | ○ 子プロセスが起動し、`system:init` メッセージ（ツール一覧、モデル、権限モード、cwd）が返る |
| 3 | 権限モード・作業フォルダ（cwd）を指定できるか | ○ `permissionMode: 'plan'`、`cwd` が init に反映された |
| 4 | Windows で使えるツール | ○ Read / Write / Edit / Glob / Grep / Bash / **PowerShell** / WebFetch / WebSearch / Skill / サブエージェント（Task）等が登録される。PowerShell ツールがあるため、Bash 用の Git for Windows が無くても最低限コマンド実行の手段がある（**要追加確認**） |
| 5 | 認証情報なしの挙動 | ダミーの API キーでは、API 呼び出しがリトライを繰り返し、結果に至らない（想定どおり。エラー表示の実装は Phase 1） |

## 実 API での検証結果（`scripts/phase0-live-check.mjs`、モデル：Haiku 4.5、費用：約 0.045 USD）

一時フォルダ（`work`）を作業フォルダとし、権限確認コールバック `canUseTool` で許可／拒否を判定して実行した。

| # | 内容 | 結果 |
|---|---|---|
| 6 | ファイルの作成（Write）・編集（Edit） | ○ 各呼び出しが `canUseTool` に渡り、許可後に実行された |
| 7 | シェルコマンドでの削除（Bash `rm hello.txt`） | ○ 事前にコマンド全文を確認でき、許可後に削除された。**Git Bash が存在する環境では Bash が動作** |
| 8 | 作業フォルダ外（`../outside.txt`）の読み取り | ○ `canUseTool` で拒否され、ファイルは読まれず無傷。Claude は拒否を受けて、その旨を報告した |
| 9 | 権限確認コールバックによる確認ダイアログの実現 | ○ ツール名・入力（パス、コマンド）が実行前に取得でき、許可／拒否を返せる。確認ダイアログは、ここで UI を待つ実装で実現できる |
| 10 | 親プロセスの認証情報を引き継がない `env` の指定 | ○ 許可リスト方式の `env` で、指定した API キーのみを使って動作 |
| 11 | 予算上限（`maxBudgetUsd`）・ターン上限（`maxTurns`）の指定 | ○ オプションとして指定可能（上限到達時の挙動は未検証） |

## Electron 上での検証結果（`scripts/phase0-electron-check.cjs`、Electron 44.5.1 のメインプロセス）

| # | 内容 | 結果 |
|---|---|---|
| 12 | `better-sqlite3` を Electron 上で読み込み、SQL を実行 | ○ 動作（ABI 149、SQLite 3.53.4） |
| 13 | Electron のメインプロセスから `query()` を実行 | ○ `Write` でファイルを作成できた（約 8 秒、約 0.03 USD） |
| 14 | 予算上限（`maxBudgetUsd`） | ○ `error_max_budget_usd` で停止。上限（0.0001 USD）を少し超えて（約 0.001 USD）停止するため、**厳密な上限ではない**（1 ターン単位） |
| 15 | ターン上限（`maxTurns`） | ○ `error_max_turns` で停止（ツール実行後、次のターンに入る前に停止） |
| 16 | 実行中の中断（`query.interrupt()`） | ○ 中断でき、`error_during_execution` で終了する。UI では「中断」として扱う |
| 17 | PATH から Git／bash を除いた環境 | ○ **PowerShell ツールでコマンド実行が成功**。Git for Windows が無くてもコマンド実行は可能 |
| 18 | `npm run dev` | ○ 開発サーバーと Electron が起動 |
| 19 | `npm run dist`（NSIS インストーラ） | ○ `Lumina Code Setup 0.1.0.exe`（約 205MB）を作成。`claude.exe`（245MB）は `app.asar.unpacked` に展開されている |

## 作業フォルダ境界の判定（`src/main/security/pathGuard.ts`、テスト：`tests/pathGuard.test.ts`）

SEC-01〜03 の判定処理を実装し、Vitest（10 件すべて成功）で確認した。

- `..` による脱出、フォルダ外の絶対パス、名前が前方一致する兄弟フォルダを拒否する。
- **ジャンクション、ファイルのシンボリックリンク**経由の脱出を拒否する（この環境では作成権限があり、実際に検証できた）。作業フォルダ内を指すリンクは許可する。
- 大文字小文字の違い、8.3 短縮名、UNC パス、デバイスパス、NTFS の代替データストリーム、NUL 文字を扱う。

## 設計上の注意（検証で判明）

- `canUseTool` に渡されるパスは、Windows の **8.3 短縮名**（`ADMINI~1`）を含む形だった。境界判定は `fs.realpathSync.native` で正規化してから行う（`pathGuard.ts` で対応済み）。
- SDK 標準のままでは、作業フォルダ外の読み取りは自動では防がれない。**境界判定は必ずアプリ側で実装する**。
- **`canUseTool` は、読み取り専用と判断されたコマンド（例：`echo hello`）では呼ばれなかった**。「すべての操作を必ず確認する」ことを保証するには、`canUseTool` だけに頼らず、権限ルール（許可／拒否）や PreToolUse フックなど SDK の別の仕組みと組み合わせる設計が必要（**Phase 1 で検証する**）。
- Bash／PowerShell は、コマンド文字列の検査だけでは境界を保証できない（要件 SEC-24 のとおり）。

## 未確認

- パッケージ済みアプリ（インストール後）での `query()` の実行（`claude.exe` の起動）
- PreToolUse フック／権限ルールによる、読み取り専用コマンドを含む全操作の確認
- 日本語など非 ASCII のパスを含む作業フォルダでの動作
- 署名なしインストーラの SmartScreen 警告（配布方法の検討事項）

## 設計への反映

- 配布物（electron-builder）では、`claude.exe` を asar の外に出す必要がある。`electron-builder.yml` の `asarUnpack` に `@anthropic-ai/claude-agent-sdk-win32-x64` を追加済み。
- インストーラーのサイズは、`claude.exe`（約 245MB）ぶん大きくなる。
- Windows ARM 対応が必要になった場合は、`win32-arm64` の同梱が必要。
- 検証スクリプトは、親プロセスの認証情報（AWS／Bedrock／既存の Anthropic 設定）を除外して実行する。

## 検証中に起きた問題（記録）

初回の実行では、ダミーの API キーを指定したにもかかわらず、実行環境に設定されていた Bedrock の認証情報（`CLAUDE_CODE_USE_BEDROCK`、`AWS_PROFILE`）が子プロセスに引き継がれ、**実際にモデルへ 1 回問い合わせが行われた**（内容は `ping` のみ、権限モードは plan）。スクリプトを修正し、`AWS_*`、`CLAUDE_CODE_USE_*`、`ANTHROPIC_*`（`ANTHROPIC_API_KEY` を除く）を除外するようにした。アプリ本体の実装でも、Agent SDK に渡す `env` は許可リスト方式で組み立てること。
