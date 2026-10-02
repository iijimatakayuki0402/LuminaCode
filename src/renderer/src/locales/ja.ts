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
    home: 'ホーム'
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
  home: {
    placeholder: 'ダッシュボードは次の段階で実装します。'
  }
} as const
