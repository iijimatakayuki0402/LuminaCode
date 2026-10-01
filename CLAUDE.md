# Lumina Code 開発ルール（Claude 用）

## 基本方針

- 開発は AI-DLC 方式で進める。手順・禁止事項・注意事項は `docs/AI-DLC方式環境構築ガイドライン.md` に従う。
- 仕様の根拠は `docs/LuminaCode_要件定義書.md`（要件 ID で参照）と `docs/LuminaCode_要望書.md`。推測で進めず、不足・矛盾は人に確認する。
- 破壊的操作、外部接続、認証情報の扱いは、事前に人へ確認する。

## 構成・コマンド

- Electron + React + TypeScript。構成は `README.md` を参照。
- 変更後は `npm run typecheck`、`npm run lint`、`npm test` を通す。

## 実装上の重要ルール（要件定義書 9 章より）

- API キーは main プロセスのみが保持し、renderer・ログ・エクスポートに出さない。
- Cowork のファイル操作は、正規化・リンク解決した上で作業フォルダ内か検証してから実行する。
- 削除は `.lumina-trash` へ退避し、確認ダイアログの権限モードに従う。
- renderer からは preload の `contextBridge` 経由でのみ main に依頼する（Node 統合は無効のまま）。
- モデル ID を固定で埋め込まない（Models API から取得）。
