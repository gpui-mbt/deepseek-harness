/** Japanese dictionary for the `settings.webSearchOllama` namespace (client/ui-settings-web-search-ollama/src/client/locales.ts). */
import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: loads the `settings.webSearchOllama` key union declared by @deepseek-ai/dsh-client-ui-settings-web-search-ollama.
import type {} from '@deepseek-ai/dsh-client-ui-settings-web-search-ollama/client'

/** `settings.webSearchOllama` copy in Japanese, complete against the owner's key union. */
export const ja: LocaleDictOf<'settings.webSearchOllama'> = {
  title: 'Ollama Cloud 検索',
  description: 'Ollama Cloud の Web 検索と取得のプロバイダーを設定します。',
  useOllama: 'Web 検索と取得に Ollama Cloud を使う',
  useOllamaHint: 'オンにすると Ollama Cloud の 2 つの能力をまとめて選び、オフにするとこのデプロイ自身の選択に戻します。',
  apiKey: 'API キー',
  apiKeyHint: '設定ファイルには書き込みません。空欄の場合は現在のキーを保持します。',
  apiKeySet: 'キーを設定済みです。',
  apiKeyUnset: 'キーが未設定です。設定するまでこのプロバイダーは検索も取得もできません。',
  searchBaseUrl: '検索 API の URL',
  searchBaseUrlHint:
    'API プレフィックスを含めてください（例: https://ollama.com）。プロバイダーが /api/web_search を付加します。空欄にすると既定値に戻ります。',
  fetchBaseUrl: '取得 API の URL',
  fetchBaseUrlHint:
    'API プレフィックスを含めてください（例: https://ollama.com）。プロバイダーが /api/web_fetch を付加します。空欄にすると既定値に戻ります。',
  maxResults: '1 回あたりの検索結果数',
  maxResultsHint: '呼び出し側がより小さい上限を要求しない場合に、1 回の検索で返す結果数です。',
  overridden: 'オーバーライド済み',
  reset: 'デフォルトに戻す',
  readOnly: 'このデプロイの設定は読み取り専用です。',
  unavailable: 'このプラグインは現在読み込まれていないため、設定できません。',
  save: '保存',
  saving: '保存中…',
  saveFailed: 'このデプロイは値を受理しませんでした。修正できるよう残しています。',
  invalidNumber: '数値を入力するか、デフォルトを使う場合は空欄にしてください。',
}
