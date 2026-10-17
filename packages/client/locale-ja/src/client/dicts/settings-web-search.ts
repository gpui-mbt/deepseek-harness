/** Japanese dictionary for the `settings.webSearch` namespace (client/ui-settings-web-search/src/client/locales.ts). */
import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: loads the `settings.webSearch` key union declared by @deepseek-ai/dsh-client-ui-settings-web-search.
import type {} from '@deepseek-ai/dsh-client-ui-settings-web-search/client'

/** `settings.webSearch` copy in Japanese, complete against the owner's key union. */
export const ja: LocaleDictOf<'settings.webSearch'> = {
  title: 'Web 検索',
  description: 'DeepSeek の検索プロバイダーを設定します。',
  useSearchApi: '新版 Web 検索 API を使用する',
  useSearchApiHint: '既定ではオフで、検索は DeepSeek Messages 経由で実行されます。新版 Web 検索 API の機能と料金は',
  searchGuide: 'Web 検索と取得のガイド',
  searchGuideUrl: 'https://api-docs.deepseek.com/guides/search',
  apiKey: 'API キー',
  apiKeyHint: '設定ファイルには書き込みません。空欄の場合は現在のキーを保持します。',
  apiKeySet: 'キーを設定済みです。',
  apiKeyUnset: 'キーが未設定です。DeepSeek アカウントのモデルを使う会話のみ、既定のエンドポイント経由で検索できます。',
  baseUrl: 'Messages API ベース URL',
  baseUrlHint:
    'API プレフィックスを含めてください（例: https://api.deepseek.com/anthropic/v1）。プロバイダーが /messages を付加します。空欄にすると既定値に戻ります。',
  searchApiBaseUrl: 'Search / Fetch API ベース URL',
  searchApiBaseUrlHint:
    'API プレフィックスを含めてください（例: https://api.deepseek.com/v1/tools）。プロバイダーが /search または /fetch を付加します。空欄にすると既定値に戻ります。',
  maxUses: '1 リクエストあたりの最大検索回数',
  maxUsesHint: '補助モデルが 1 つの Messages リクエスト内で実行できる検索回数です。Messages API にのみ適用されます。',
  count: '1 回あたりの検索結果数',
  countHint:
    'クエリごとに返す結果数です。1〜50 の整数で、既定は 10 です。検索回数ではなく結果数を制御します。web_search が保持するソース数は、それ自身の結果上限を超えません。',
  overridden: 'オーバーライド済み',
  reset: 'デフォルトに戻す',
  readOnly: 'このデプロイの設定は読み取り専用です。',
  unavailable: 'このプラグインは現在読み込まれていないため、設定できません。',
  save: '保存',
  saving: '保存中…',
  saveFailed: 'このデプロイは値を受理しませんでした。修正できるよう残しています。',
  invalidNumber: '数値を入力するか、デフォルトを使う場合は空欄にしてください。',
  invalidCount: '1〜50 の整数を入力するか、デフォルトを使う場合は空欄にしてください。',
}
