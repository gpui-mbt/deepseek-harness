/** Display-only release marking; the catalog and selected route remain unchanged. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DeepSeekModelLabel.module.css'

/**
 * Model id carrying the 1017 build on each route that serves it: the two
 * official DeepSeek routes name it `deepseek-flash`, and Ollama Cloud serves
 * the same batch under its pinned tag. A route absent here keeps its catalog
 * name untouched.
 */
const BATCH_MODEL_IDS: Readonly<Record<string, string>> = {
  'deepseek-account': 'deepseek-flash',
  'deepseek-official': 'deepseek-flash',
  'ollama-cloud': 'deepseek-v4.1-flash:1017',
}

/** Name the DeepSeek catalog gives the build, shared by every route serving it. */
const MODEL_NAME = 'DeepSeek-V4.1-Flash'

/**
 * Render the fixed 1017 release label for recognized Flash entries.
 * @param props - Provider and model identity plus the badge dictionary.
 * @returns The base name with a badge, or the untouched catalog name.
 */
export function DeepSeekModelLabel({
  provider,
  model,
  t,
}: PropsRuntime<'conversation.input.model.label'> & PropsLocale<'deepseek-model-label-1017'>) {
  if (BATCH_MODEL_IDS[provider.id] !== model.id || model.name !== MODEL_NAME) return model.name
  return (
    <span className={css.label}>
      <span>{model.name}</span> <Tag tone="info">{t('badge.label')}</Tag>
    </span>
  )
}
