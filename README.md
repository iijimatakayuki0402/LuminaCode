# Lumina Code 開発環境

Claude API 専用の個人用ローカルチャットアプリ「Lumina Code」の開発フォルダです。
要望・要件は `docs/` を参照してください（AI-DLC 方式で開発します）。

## 技術スタック

| 区分        | 採用                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| アプリ基盤  | Electron 44 + electron-vite 5                                                   |
| UI          | React 19 + TypeScript 6.0 + Tailwind CSS v4                                     |
| Claude 連携 | `@anthropic-ai/sdk`（通常チャット）／`@anthropic-ai/claude-agent-sdk`（Cowork） |
| データ保存  | better-sqlite3（SQLite）                                                        |
| 品質        | ESLint 9（flat config）、Prettier、Vitest                                       |
| 配布        | electron-builder（NSIS）                                                        |

## 必要環境

- Windows 10/11、Node.js 22 以上（確認済み: v24.19.0）、npm 11、Git

## セットアップ

```powershell
npm install
npm approve-scripts electron better-sqlite3 esbuild   # 初回のみ（install スクリプトの承認）
npm rebuild electron esbuild
node node_modules/electron/install.js                 # Electron 本体の取得
```

## コマンド

| コマンド                          | 内容                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`                     | 開発起動（ホットリロード）                                                  |
| `npm run build`                   | 型チェック＋ビルド（`out/` に出力）                                         |
| `npm run typecheck`               | 型チェック                                                                  |
| `npm run lint` / `npm run format` | Lint ／ 整形                                                                |
| `npm test`                        | テスト（Vitest）                                                            |
| `npm run test:electron`           | テストを Electron のランタイムで実行                                        |
| `npm run dist`                    | Windows インストーラー作成（`dist/`）                                       |
| `npm run licenses`                | 同梱ライセンス一覧の作成（`resources/licenses.json`。`build` でも自動実行） |

## 技術検証スクリプト（Phase 0）

API キーは環境変数 `LUMINA_TEST_API_KEY` で渡します（ファイルには保存しません。実 API を呼ぶため少額の費用がかかります）。

| スクリプト                          | 内容                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `scripts/phase0-sdk-check.mjs`      | SDK の起動確認（ダミーキー、課金なし）                                                  |
| `scripts/phase0-live-check.mjs`     | 権限確認コールバックと作業フォルダ境界（Node）                                          |
| `scripts/phase0-electron-check.cjs` | Electron 上での実行、上限、中断など（`npx electron scripts/phase0-electron-check.cjs`） |

結果は `docs/Phase0_技術検証結果.md` を参照してください。

## フォルダ構成

```
docs/        要望書・要件定義書・ガイドライン
src/main/    Electron メインプロセス（ファイル I/O、DB、API キー、Agent SDK、安全機能）
src/preload/ contextBridge で公開する API
src/renderer/ UI（React）
src/shared/  main／renderer 共通の型・定数
tests/       テスト
scripts/     環境構築・運用スクリプト
```

## 注意

- `better-sqlite3`（v13）は N-API 版の同梱バイナリ（`prebuilds/`）を使うため、Node と Electron の両方でそのまま動きます（再ビルド不要）。本番と同じランタイムで確認したい場合は `npm run test:electron` を使います。
- API キーは `.env` に書かず、アプリの設定画面から登録します（DPAPI で暗号化保存）。
- API キーの暗号化に使う鍵は、データ保存先の `Local State` に（DPAPI で保護されて）保存されます。`api-key.bin` だけを別の場所へコピーしても復号できません。バックアップ・復元を実装する際は注意してください。
- Cowork は Agent SDK（同梱の `claude.exe`）を作業フォルダで実行します。SDK の設定・セッションはデータ保存先の `agent\` に保存し、ユーザーの `~/.claude` や作業フォルダの `.claude\settings.json`（hooks など）は読み込みません。すべてのツール実行はアプリの PreToolUse フックで判定します（`src/main/cowork/policy.ts`）。
- 開発時（パッケージ化していない場合）は、環境変数 `LUMINA_USER_DATA_DIR` でデータ保存先を切り替えられます（動作確認で本来のデータを汚さないため）。

## 更新の配信（CMN-03）

- 配信元は GitHub Releases の公開リポジトリ [iijimatakayuki0402/LuminaCode](https://github.com/iijimatakayuki0402/LuminaCode) です（リリース専用で、ソースは置きません。アプリにトークンは持たせません）。設定は `electron-builder.yml` の `publish` にあります。
- 更新は起動の 10 秒後と、設定画面の「更新を確認」で確認します（パッケージ版のみ）。ダウンロードとインストール（再起動）は、どちらもユーザーが操作したときだけ行います。
- リリースの手順:
  1. `package.json` の `version` を上げる（例: `0.1.0` → `0.2.0`）。
  2. `npm run dist` を実行する（`--publish never` を付けているため、ビルドだけでアップロードはしません）。
  3. GitHub のリポジトリで、タグ `v<バージョン>`（例: `v0.2.0`）のリリースを作り、`dist/` の `latest.yml`、インストーラー（`lumina-code-setup-<バージョン>.exe`）と `.blockmap` を添付して公開する（下書きのままでは配信されません）。
- リリースが 1 つも無い間は、確認すると「更新を確認できませんでした」と表示されます。
- インストーラーにはコード署名をしていません。改ざんの検出は `latest.yml` の SHA-512 で行います（GitHub は HTTPS で配信します）。
- 開発時に確認の動作を試す場合は、プロジェクト直下に `dev-app-update.yml`（`provider: github`、`owner`、`repo`）を置きます（Git の管理対象外です。インストールはできません）。

## Web 検索（CHT-11）

- 通常チャットはプロジェクトの画面の「Web 検索」、Cowork は右パネルの設定でオンにします（既定はオフ）。
- Claude API のサーバー側の Web 検索ツールを使います。検索 1 回あたり約 0.01 USD がトークンとは別にかかり、概算コストに含めます。
- 組織の設定で Web 検索が無効になっている場合は、Anthropic の Console で有効にしてください。

## アンインストール（10.4）

- アンインストールの途中で、アプリのデータ（`%APPDATA%\LuminaCode`）も削除するかを確認します。既定は「いいえ（残す）」です。
- 更新によるアンインストールのときと、サイレント実行（`/S`）のときは、確認せずにデータを残します。
- Cowork の作業フォルダ（その中の `.lumina-trash` も含めて）は削除しません。処理は `build/installer.nsh` にあります。
