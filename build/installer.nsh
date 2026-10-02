; アンインストール時の処理（要件 10.4）
; アプリデータ（%APPDATA%\LuminaCode）を削除するかをユーザーに選んでもらう（既定は「残す」）。
; - 更新（electron-updater による再インストール）や、サイレント実行のときは尋ねずに残す
; - Cowork の作業フォルダ（およびその中の .lumina-trash）は、どちらを選んでも削除しない
; このファイルは UTF-8（BOM 付き）で保存する（日本語のメッセージを正しく表示するため）

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "アプリのデータも削除しますか？$\r$\n$\r$\n削除するもの: 会話の履歴、プロジェクト、設定、API キー、ログ、バックアップ$\r$\n保存先: $APPDATA\LuminaCode$\r$\n$\r$\n「いいえ」を選ぶとデータを残します（再インストールすると引き継げます）。$\r$\nCowork の作業フォルダ内のファイルは、どちらを選んでも削除しません。" /SD IDNO IDNO luminaKeepData
      SetShellVarContext current
      RMDir /r "$APPDATA\LuminaCode"
      ; 更新のダウンロード用の一時フォルダ（electron-updater）
      RMDir /r "$LOCALAPPDATA\lumina-code-updater"
    luminaKeepData:
  ${endIf}
!macroend
