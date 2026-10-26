/** Official OpenAI Responses models whose input limits are documented here.
 *
 * Model facts come from the official API model catalog and exact model pages:
 * https://developers.openai.com/api/docs/models
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * https://developers.openai.com/api/docs/models/gpt-6-sol
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * https://developers.openai.com/api/docs/guides/reasoning
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ReasoningEffortId as ReasoningEffortIdType,
} from '@deepseek-ai/dsh-llm'

const ADDITIONAL_TOOL_UPDATE = 'addition-only' as const

/** Model facts resolved from official metadata or a profile override. */
export interface OpenAiModelFacts {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly contextWindow: number
  /** Accepted request modalities; omitted when neither official facts nor an override state them. */
  readonly inputModalities?: readonly ModelModality[]
  readonly reasoningEfforts: readonly ReasoningEffortIdType[]
  /** Omitted when the official reasoning guide does not list a default. */
  readonly defaultReasoningEffort?: ReasoningEffortIdType
}

/** Static facts taken from the official OpenAI API model catalog. */
export interface OfficialOpenAiModel extends OpenAiModelFacts {
  /** Published output capacity; never materialized as a DSH default. */
  readonly maxOutputTokens?: number
  readonly inputModalities: readonly ModelModality[]
}

const modalities = ['text', 'image'] as const satisfies readonly ModelModality[]
const contextWindow = 1_050_000
const maxOutputTokens = 128_000
const astraEfforts = ['low', 'medium', 'high', 'xhigh', 'max'].map(ReasoningEffortId)
const generalEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(ReasoningEffortId)
const medium = ReasoningEffortId('medium')

/** Exact model IDs and published capabilities; no date aliases are inferred. */
export const OFFICIAL_OPENAI_MODELS: readonly OfficialOpenAiModel[] = Object.freeze([
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    description: 'Our most capable model for the most demanding work.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: astraEfforts,
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    description: 'Near-Astra performance for complex work at a lower cost.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: astraEfforts,
    defaultReasoningEffort: medium,
  },
  {
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    description: 'Built to power complex coding and agentic workflows.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: generalEfforts,
    defaultReasoningEffort: medium,
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    description: 'Our most efficient model for focused, high-volume tasks.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: generalEfforts,
    defaultReasoningEffort: medium,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    description: 'GPT-5.6 flagship model for complex professional work.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: generalEfforts,
    defaultReasoningEffort: medium,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    description: 'GPT-5.6 model that balances intelligence and cost.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: generalEfforts,
    defaultReasoningEffort: medium,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    description: 'GPT-5.6 model optimized for cost-sensitive workloads.',
    contextWindow,
    maxOutputTokens,
    inputModalities: modalities,
    reasoningEfforts: generalEfforts,
    defaultReasoningEffort: medium,
  },
])

const officialById = new Map(OFFICIAL_OPENAI_MODELS.map(model => [model.id, model]))

/** Resolve documented facts for one exact official model ID.
 * @param model - model slug from the provider catalog.
 * @returns the documented facts, or undefined for a slug the table does not know.
 */
export function officialOpenAiModel(model: string): OfficialOpenAiModel | undefined {
  return officialById.get(model)
}

/** Build list metadata for one exact model route.
 * @param provider - provider route that owns the model.
 * @param model - resolved facts for that route.
 * @returns selector-facing metadata for the model.
 */
export function toOpenAiModelInfo(provider: string, model: OpenAiModelFacts): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    description: model.description,
    ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
  }
}

/** Build resolved DSH capabilities without materializing an output-token cap.
 * @param provider - provider route that owns the model.
 * @param model - resolved facts for that route.
 * @returns capability metadata the harness can select.
 */
export function toOpenAiResolvedModelInfo(provider: string, model: OpenAiModelFacts): LlmResolvedModelInfo {
  return {
    ...toOpenAiModelInfo(provider, model),
    context: { contextWindow: model.contextWindow },
    reasoning: {
      efforts: model.reasoningEfforts.map(id => ({ id, name: String(id) })),
      ...(model.defaultReasoningEffort === undefined ? {} : { defaultEffort: model.defaultReasoningEffort }),
    },
    toolUpdate: ADDITIONAL_TOOL_UPDATE,
  }
}
