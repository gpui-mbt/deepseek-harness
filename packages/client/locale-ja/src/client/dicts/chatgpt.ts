/** Japanese dictionary for the `chatgpt` namespace (client/ui-chatgpt/src/client/locales.ts). */
import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: loads the `chatgpt` key union declared by @deepseek-ai/dsh-client-ui-chatgpt/client.
import type {} from '@deepseek-ai/dsh-client-ui-chatgpt/client'

/** `chatgpt` copy in Japanese, complete against the owner's key union. */
export const ja: LocaleDictOf<'chatgpt'> = {
  nav: 'ChatGPT',
  summary: 'ChatGPT アカウントを接続し、そのアカウントが提供するモデルを調整します。',
  title: 'ChatGPT プラン',
  intro: '対象のリクエストはChatGPTプランを使用します。'
    + '他のプロバイダー向けリクエストは設定済みの認証情報と料金体系を引き続き使います。'
    + 'アカウント認証情報はHost認証情報ストアに保存されます。',
  accounts: 'アカウント',
  activeAccount: '使用するアカウント',
  noActiveAccount: 'アカウントが選択されていません',
  noAccounts: 'ChatGPTアカウントがまだ接続されていません。',
  continueWithChatGPT: 'ChatGPTで続行',
  openBrowser: 'ブラウザーで続行',
  cancelLogin: 'ログインをキャンセル',
  loginWaiting: 'ブラウザーでのログインを待っています…',
  loginExchanging: 'ログインを完了しています…',
  loginComplete: 'ログインが完了しました',
  loginFailed: 'ログインを完了できませんでした。',
  loginCancelled: 'ログインをキャンセルしました。ブラウザーのログインタブがまだ開いている場合は閉じてください。',
  connected: '接続済み',
  registrationRequired: '登録が必要です',
  signInRequired: '再ログインが必要です',
  accountModels: '利用可能なモデル',
  refreshModels: 'モデル一覧を更新',
  refreshing: '更新中…',
  modelsEmpty: 'このアカウントには表示可能なモデルがありません。',
  modelReady: '使用できます',
  modelNeedsContext: 'このモデルを選択するにはコンテキスト長を設定してください。',
  modelSettings: 'モデルの機能設定',
  contextWindow: 'コンテキスト長（トークン）',
  contextWindowRequired: 'このモデルを選択できるように、正の整数を入力してください。',
  inputModalities: '入力形式',
  inputTypeRequired: '入力形式を1つ以上選択してください。',
  textInput: 'テキスト',
  imageInput: '画像',
  reasoningEfforts: '推論レベル（カンマ区切り）',
  reasoningPlaceholder: 'low, medium, high',
  defaultReasoningEffort: '既定の推論レベル',
  reasoningDefaultUnavailable: 'サポートされている推論レベルから既定値を選択してください。',
  save: 'モデル設定を保存',
  saving: '保存中…',
  resetModel: '公式モデル設定に戻す',
  modelSaved: 'モデル設定を保存しました。',
  signOut: 'サインアウト',
  cancel: 'キャンセル',
  confirmSignOut: 'このアカウントからサインアウトしますか？',
  confirmSignOutDescription: 'OpenAIにリフレッシュトークンの失効を依頼し、このプロファイルからトークンを削除します。'
    + '再認証用のアカウント登録は残ります。',
  confirm: 'サインアウト',
  signOutRevocationUnconfirmed: 'このプロファイルからサインアウトしましたが、OpenAIはトークンの失効を確認しませんでした。',
  actionFailed: 'リクエストを完了できませんでした。接続を確認して、もう一度お試しください。',
  welcomeTitle: 'ChatGPTプランを使用します',
  welcomeDescription: '対象のリクエストはChatGPTプランを使用します。'
    + '利用状況と上限はChatGPTの設定で管理できます。',
  continue: '確認',
  usingPlan: 'ChatGPTプランを使用中',
  manageUsage: '利用状況を管理',
  usageLimitTitle: 'ChatGPTプランの利用上限に達しました',
  usageLimitDescription: 'このリクエストはChatGPTプランの利用上限に達しました。'
    + '利用状況またはプランの詳細を確認してください。',
  close: '閉じる',
  loading: 'ChatGPTアカウントを読み込んでいます…',
}
