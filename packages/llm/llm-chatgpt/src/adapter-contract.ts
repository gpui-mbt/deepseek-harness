/** Host-owned, per-call facts consumed by the ChatGPT Responses adapter. */

import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ChatGptAccountId } from './types.ts'

/** A selected account and resolved bearer credential held stable for one call. */
export interface ChatGptPreparedCall {
  readonly accountId: ChatGptAccountId
  readonly accessToken: string
  /** Aborted by the host when this account signs out or loses its grant. */
  readonly accountSignal: AbortSignal
  readonly model: LlmResolvedModelInfo
  readonly requestTimeoutMs: number
  /** Quiet period after which the stream counts as stalled; zero disables the check. */
  readonly streamIdleTimeoutMs: number
}

/** Narrow host seam used by the standalone Responses API adapter. */
export interface ChatGptAdapterHost {
  /** Models already admitted by account policy and backed by a configured context cap. */
  listModels(): Promise<readonly LlmModelInfo[]>
  /** Resolve one exact model from official metadata or an explicit host override. */
  resolveModel(model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  /** Pin the selected account, current bearer token, exact model, and request deadlines. */
  prepareCall(model: string, signal?: AbortSignal): Promise<ChatGptPreparedCall>
  /** Read and verify one stored image for inline Responses API input. */
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}
