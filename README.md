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
npm run rebuild                                       # better-sqlite3 を Electron 用に再ビルド
```

## コマンド

| コマンド                          | 内容                                  |
| --------------------------------- | ------------------------------------- |
| `npm run dev`                     | 開発起動（ホットリロード）            |
| `npm run build`                   | 型チェック＋ビルド（`out/` に出力）   |
| `npm run typecheck`               | 型チェック                            |
| `npm run lint` / `npm run format` | Lint ／ 整形                          |
| `npm test`                        | テスト（Vitest）                      |
| `npm run dist`                    | Windows インストーラー作成（`dist/`） |

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

- `better-sqlite3` は **Electron 用にビルド**されています。Vitest（Node）から直接読み込むと ABI 不一致になります。DB を使うテストは、DB アクセス層を分離するか、Node 用に再ビルドして実行してください。
- API キーは `.env` に書かず、アプリの設定画面から登録します（DPAPI で暗号化保存）。
