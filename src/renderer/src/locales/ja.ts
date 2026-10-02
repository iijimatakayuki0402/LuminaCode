/**
 * 画面の文言（要件 10.3: 将来の多言語化に備えてリソースとして分離する）
 */
export const ja = {
  common: {
    save: '保存',
    cancel: 'キャンセル',
    back: '戻る',
    loading: '読み込み中…'
  },
  nav: {
    settings: '設定',
    home: 'ホーム',
    dashboard: 'ダッシュボード'
  },
  setup: {
    title: 'SETUP / API キーの登録',
    lead: 'Lumina Code を使うには、Anthropic の API キーが必要です。保存前に接続を確認し、成功した場合のみ暗号化して保存します。',
    later: '後で設定する'
  },
  apiKey: {
    section: 'API キー',
    label: 'API キー',
    placeholder: 'sk-ant-...',
    saveAndTest: '接続を確認して保存',
    testing: '接続を確認しています…',
    saved: 'API キーを保存しました。',
    current: '登録済みのキー',
    notConfigured: '未設定',
    change: '変更',
    test: '接続テスト',
    testOk: '接続できました。',
    delete: '削除',
    deleteConfirm:
      '保存している API キーを削除します。チャットと Cowork は使えなくなります。よろしいですか？',
    deleted: 'API キーを削除しました。',
    encryptionUnavailable: 'この環境では OS の暗号化機能が使えないため、API キーを保存できません。',
    requiredNotice: 'API キーが未設定のため、チャットと Cowork は利用できません。',
    goSettings: '設定画面で登録する'
  },
  models: {
    section: 'モデル',
    defaultModel: '既定のモデル',
    none: '（モデル一覧がありません）',
    refresh: '一覧を更新',
    refreshing: '更新しています…',
    fetchedAt: (date: string) => `一覧の取得日時: ${date}`,
    stale: 'モデル一覧を取得できなかったため、前回の一覧を表示しています。',
    needKey: 'API キーを登録すると、モデル一覧を取得できます。',
    saved: '既定のモデルを変更しました。'
  },
  projectType: {
    chat: 'チャット',
    cowork: 'Cowork'
  },
  permissionMode: {
    confirm_each: '毎回確認',
    auto_edit: '編集を自動許可',
    plan_only: '計画のみ'
  },
  dashboard: {
    title: 'PROJECTS',
    create: '新規プロジェクト',
    search: 'プロジェクト名で検索',
    filterAll: 'すべての種別',
    sortLabel: '並び順',
    sortUpdated: '最終更新順',
    sortCreated: '作成順',
    sortName: '名前順',
    showArchived: 'アーカイブを表示',
    empty: 'プロジェクトがありません。「新規プロジェクト」から作成してください。',
    noMatch: '条件に一致するプロジェクトはありません。',
    updatedAt: (date: string) => `最終更新 ${date}`,
    pinned: 'ピン留め中',
    archived: 'アーカイブ済み',
    open: '開く',
    edit: '編集',
    duplicate: '複製',
    pin: 'ピン留め',
    unpin: 'ピン留めを外す',
    archive: 'アーカイブ',
    unarchive: 'アーカイブから戻す',
    delete: '削除',
    deleteTitle: 'プロジェクトの削除',
    deleteMessage: (name: string) =>
      `「${name}」を削除します。スレッドと会話の履歴も削除され、元に戻せません。`,
    deleteCoworkNote: '作業フォルダ内のファイルは削除されません。',
    copySuffix: ' のコピー',
    keyRequired: 'API キーを登録すると、プロジェクトを開けます。'
  },
  projectDialog: {
    createTitle: '新規プロジェクト',
    editTitle: 'プロジェクトの編集',
    duplicateTitle: 'プロジェクトの複製',
    type: '種別',
    typeLocked: '種別は作成後に変更できません。変更したい場合は「複製」で作り直してください。',
    name: 'プロジェクト名',
    customInstructions: 'カスタム指示（任意）',
    workFolder: '作業フォルダ',
    browse: '参照…',
    workFolderHint: 'Cowork はこのフォルダの中だけを操作します。',
    model: 'モデル（任意）',
    useDefault: (model: string | null) => `全体の既定を使う${model ? `（${model}）` : ''}`,
    permissionMode: '権限モード',
    submitCreate: '作成',
    submitSave: '保存',
    count: (n: number, max: number) => `${n.toLocaleString()} / ${max.toLocaleString()} 文字`,
    changeFolderTitle: '作業フォルダの変更',
    changeFolderLead: '作業フォルダを変更します。以後の Cowork の操作対象が切り替わります。',
    changeFolderFrom: '変更前',
    changeFolderTo: '変更後',
    changeFolderConfirm: '変更する'
  },
  project: {
    back: '一覧へ戻る',
    threads: 'スレッド',
    newThread: '新規スレッド',
    untitled: '無題のスレッド',
    rename: '名前を変更',
    renameSave: '変更',
    delete: '削除',
    deleteTitle: 'スレッドの削除',
    deleteMessage: (title: string) => `「${title}」を削除します。会話の履歴は元に戻せません。`,
    noThreads: 'スレッドがありません。「新規スレッド」から始めてください。',
    model: 'モデル',
    modelSource: { thread: 'スレッド', project: 'プロジェクト', default: '全体の既定' },
    noModel: '未選択（設定画面でモデル一覧を更新してください）',
    threadModel: 'このスレッドのモデル',
    inherit: (model: string | null) =>
      `プロジェクト／全体の設定を使う${model ? `（${model}）` : ''}`,
    chatComingSoon: '会話の送受信は次の段階で実装します。',
    workFolder: '作業フォルダ',
    permissionMode: '権限モード'
  },
  appearance: {
    section: '表示',
    mode: '表示モード',
    modes: { dark: 'ダーク', light: 'ライト', system: '標準（OS の設定に従う）' },
    accent: 'アクセントカラー',
    accents: { purple: '薄紫', cyan: '水色', red: '薄い赤' }
  }
} as const
