/**
 * 画面の文言（要件 10.3: 将来の多言語化に備えてリソースとして分離する）
 */
/** 金額の表示（少額でも 0 にならないよう、大きさに応じて桁数を変える） */
const formatUsd = (usd: number): string =>
  usd === 0 ? '0' : usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(4) : usd.toPrecision(2)

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
  chat: {
    user: 'USER',
    assistant: 'CLAUDE',
    copy: 'コピー',
    copyCode: 'コピー',
    copied: 'コピーしました',
    edit: '編集',
    resend: '再送信',
    regenerate: '再生成',
    placeholder: (sendKey: 'enter' | 'ctrl_enter') =>
      sendKey === 'enter'
        ? 'メッセージを入力（Enter で送信、Shift+Enter で改行）'
        : 'メッセージを入力（Ctrl+Enter で送信、Enter で改行）',
    send: '送信',
    stop: '停止',
    attach: 'ファイルを添付',
    dropHere: 'ここにドロップして添付',
    removeAttachment: (name: string) => `${name} を取り外す`,
    thinking: '思考の要約',
    thinkingNow: '考えています…',
    streaming: '生成中…',
    status: {
      stopped: '停止しました（ここまでの応答を保持しています）',
      error: 'エラーで中断しました',
      interrupted: 'アプリの終了により中断しました（ここまでの応答を保持しています）'
    },
    refusal: 'この依頼への回答は控えられました。',
    maxTokens: '出力の上限に達したため、途中で終わっています。',
    retrying: (attempt: number, max: number, seconds: number) =>
      `再試行を待っています（${attempt}/${max} 回目、約 ${seconds} 秒後）`,
    offline: 'オフラインです。接続が回復すると送信できます。',
    empty: '最初のメッセージを送信してください。',
    tokens: (n: number) => `${n.toLocaleString()} tokens`,
    cost: (usd: number) => `約 $${formatUsd(usd)}`,
    coworkComingSoon: 'Cowork の実行は次の段階で実装します。',
    sendKey: '送信キー',
    sendKeys: { enter: 'Enter で送信', ctrl_enter: 'Ctrl+Enter で送信' }
  },
  cowork: {
    tools: 'ツール実行',
    category: {
      read: '読み取り',
      write: '書き込み',
      delete: '削除',
      command: 'コマンド',
      plan: '計画',
      web: 'Web',
      other: 'その他'
    },
    method: {
      auto: '自動許可',
      allowed_once: '今回だけ許可',
      allowed_always_thread: 'スレッドで常に許可',
      allowed_always_project: 'プロジェクトで常に許可',
      denied: '拒否'
    },
    running: '実行中…',
    permissionTitle: (category: string) => `確認: ${category}`,
    permissionLead: (tool: string) => `Claude が次の操作（${tool}）を実行しようとしています。`,
    targets: (n: number) => `対象（${n} 件）`,
    kind: { file: 'ファイル', folder: 'フォルダ', missing: '新規' },
    command: '実行するコマンド',
    detail: '内容',
    dangerNote: (reason: string) => `注意: ${reason}の操作です。内容をよく確認してください。`,
    bulkNote: '多数のファイル、またはフォルダの削除のため、毎回確認します。',
    commandNote:
      'コマンドの実行は、作業フォルダの外への影響を完全には防げません。内容を確認してから許可してください。',
    allowOnce: '今回だけ許可',
    allowThread: 'このスレッドでは常に許可',
    allowProject: 'このプロジェクトでは常に許可',
    deny: '拒否',
    changes: '変更されたファイル',
    showChanges: (n: number) => `変更を確認（${n} 件）`,
    hideChanges: '閉じる',
    changeKind: { modified: '変更', created: '作成', trashed: '削除（退避）' },
    restored: '元に戻し済み',
    showDiff: '差分',
    undo: 'この実行の変更を元に戻す',
    undoTitle: '変更を元に戻す',
    undoMessage:
      'この実行でアプリ経由に行った変更を、実行前の状態に戻します。作成したファイルは .lumina-trash に退避します。',
    undoDone: (n: number) => `${n} 件を元に戻しました。`,
    undoSkipped: (items: string) => `元に戻せなかったもの: ${items}`,
    bashNote:
      'Bash／PowerShell のコマンドで行われた変更は、元に戻す対象になりません（Git で管理している場合は Git で戻してください）。',
    diffTitle: (path: string) => `差分: ${path}`,
    binary: 'テキストではない、または大きすぎるため、差分を表示できません。',
    noDiff: '変更はありません。',
    todos: 'TODO',
    todoStatus: { pending: '未着手', in_progress: '進行中', completed: '完了' },
    resendTitle: '再送信の前に',
    resendMessage:
      '再送信しても、前回の実行で行われたファイルの変更は自動では元に戻りません。前回の変更を元に戻しますか？',
    resendUndo: '元に戻してから再送信',
    resendKeep: 'そのまま再送信',
    noAttachments:
      'Cowork では添付ファイルは使えません。作業フォルダにファイルを置いて指示してください。',
    modeLabel: '権限モード',
    always: '常に許可',
    alwaysNone: 'なし',
    alwaysScope: { thread: 'このスレッド', project: 'このプロジェクト' },
    clear: '解除',
    commandLimit:
      'コマンド実行は作業フォルダの外への影響を完全には防げません。重要なフォルダでは「計画のみ」または「毎回確認」をお勧めします。',
    prefsSection: 'Cowork のコマンド',
    denyPatterns: '拒否するコマンド（正規表現。1 行に 1 つ）',
    allowCommands: '確認なしで許可するコマンド（1 行に 1 つ。末尾の * で前方一致）',
    prefsSaved: '保存しました。'
  },
  logs: {
    title: 'OPERATION LOG',
    nav: '操作ログ',
    project: 'プロジェクト',
    allProjects: 'すべてのプロジェクト',
    category: '種別',
    allCategories: 'すべての種別',
    query: '対象・コマンドで検索',
    from: '開始日',
    to: '終了日',
    search: '検索',
    exportCsv: 'CSV で書き出す',
    exportJson: 'JSON で書き出す',
    exported: (path: string) => `書き出しました: ${path}`,
    columns: {
      time: '日時',
      project: 'プロジェクト',
      tool: '操作',
      target: '対象',
      method: '許可方法',
      result: '結果'
    },
    empty: '該当するログはありません。',
    count: (n: number) => `${n.toLocaleString()} 件`,
    limitNote: (n: number) => `新しい順に ${n.toLocaleString()} 件まで表示しています。`,
    retention: (days: number) =>
      `ログは ${days} 日間保持し、それより古いものは起動時に削除します。`,
    deleteOld: '指定した終了日より前のログを削除',
    deleteTitle: '操作ログの削除',
    deleteMessage: (date: string) => `${date} より前の操作ログを削除します。元に戻せません。`,
    deleted: (n: number) => `${n.toLocaleString()} 件を削除しました。`,
    needTo: '削除するには終了日を指定してください。'
  },
  trash: {
    open: '退避したファイル',
    title: '退避したファイル（.lumina-trash）',
    empty: '退避したファイルはありません。',
    deletedAt: '削除日時',
    restore: '復元',
    restored: (path: string) => `復元しました: ${path}`,
    purge: (days: number) => `${days} 日より前のものを完全に削除`,
    purgeTitle: '退避したファイルの完全削除',
    purgeMessage: (days: number) =>
      `${days} 日より前に退避したファイルを完全に削除します。元に戻せません。`,
    purged: (n: number) => `${n} 回分の退避を完全に削除しました。`
  },
  usage: {
    nav: '使用量',
    title: 'USAGE',
    month: '月',
    disclaimer:
      'コストは単価表に基づく概算です。実際の請求額とは異なります。正確な金額は Anthropic のコンソールで確認してください。',
    total: '当月の合計',
    tokens: (input: number, output: number) =>
      `入力 ${input.toLocaleString()} / 出力 ${output.toLocaleString()} tokens`,
    requests: (n: number) => `${n.toLocaleString()} 回`,
    cost: (usd: number) => `約 $${formatUsd(usd)}`,
    ofLimit: (usd: number, limit: number) => `約 $${formatUsd(usd)} / 上限 $${formatUsd(limit)}`,
    noLimit: '上限なし',
    byProject: 'プロジェクト別（当月）',
    byMonth: '月別の推移',
    project: 'プロジェクト',
    costColumn: '概算コスト',
    tokensColumn: 'トークン',
    projectLimit: '上限（USD / 月）',
    setLimit: '設定',
    clearLimit: '解除',
    none: 'まだ使用量はありません。',
    warning: (percent: number) => `使用量が上限の ${percent}% に達しています。`,
    exceededStop:
      '使用量が上限に達したため、新しいリクエストを停止しています。上限を引き上げるか、解除してください。',
    exceededWarn: '使用量が上限を超えています（設定により警告のみ）。',
    threadTotal: (tokens: number, usd: number) =>
      `スレッド累計 ${tokens.toLocaleString()} tokens・約 $${formatUsd(usd)}`,
    settings: '使用量の上限',
    monthlyLimit: '月額上限（USD。空欄で上限なし）',
    action: '上限に達したとき',
    actions: { stop: '新しいリクエストを停止する（推奨）', warn: '警告のみ' },
    saved: '保存しました。',
    pricingFile: (path: string) => `単価表のファイル: ${path}`,
    pricingNote: '単価表は JSON ファイルを編集して更新できます（次のリクエストから反映）。'
  },
  data: {
    section: 'データ',
    dataPath: (path: string) => `データ保存先: ${path}`,
    logPath: (path: string) => `アプリログ: ${path}`
  },
  appearance: {
    section: '表示',
    mode: '表示モード',
    modes: { dark: 'ダーク', light: 'ライト', system: '標準（OS の設定に従う）' },
    accent: 'アクセントカラー',
    accents: { purple: '薄紫', cyan: '水色', red: '薄い赤' }
  }
} as const
