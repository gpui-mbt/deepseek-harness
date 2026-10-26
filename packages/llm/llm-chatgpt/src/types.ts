/** Client-safe account and model settings shared with the generated Remote API. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelModality } from '@deepseek-ai/dsh-llm'

/** Opaque profile-scoped identity for one ChatGPT account registration. */
export type ChatGptAccountId = Branded<'ChatGptAccountId'>

/** Opaque Host-local handle for one pending sign-in attempt. */
export type ChatGptLoginAttemptId = Branded<'ChatGptLoginAttemptId'>

/** Model capabilities the user can override through cordis.yml or settings. */
export interface ChatGptModelConfig {
  /** Maximum combined request and response context, required for unknown models. */
  readonly contextWindow?: number | undefined
  /** Model request modalities; omitted uses the official model metadata. */
  readonly inputModalities?: readonly ModelModality[] | undefined
  /** Selectable reasoning values for a model with provider-supported effort. */
  readonly reasoningEfforts?: readonly string[] | undefined
  /** Default reasoning effort; omitted leaves the provider default in effect. */
  readonly defaultReasoningEffort?: string | undefined
}

/** One per-profile model override keyed by an exact catalog slug. */
export interface ChatGptModelOverride extends ChatGptModelConfig {
  /** Exact model slug returned by OpenAI. */
  readonly model: string
}

/** A sanitized model row from one connected account's server catalog. */
export interface ChatGptModelView extends ChatGptModelConfig {
  /** Exact model slug accepted by the Responses endpoint. */
  readonly slug: string
  /** Server-authored display name. */
  readonly displayName: string
  /** Whether this model has enough configured metadata for safe DSH selection. */
  readonly usable: boolean
  /** True when a per-profile override contributes one or more capabilities. */
  readonly overridden: boolean
}

/** Safe summary of one account registration; token values never cross Remote. */
export interface ChatGptAccountView {
  /** Opaque profile-scoped account identity. */
  readonly id: ChatGptAccountId
  /** Display label, falling back to the account's redacted identifier. */
  readonly label: string
  /** Verified account email when OpenID returned one. */
  readonly email?: string
  /** Whether profile model requests use this account. */
  readonly active: boolean
  /** Credential and dynamic-client registration state, without secret details. */
  readonly status: 'connected' | 'needs-registration' | 'needs-sign-in'
  /** Server model catalog filtered to rows with `visibility: "list"`. */
  readonly models: readonly ChatGptModelView[]
}

/** Redacted progress for one Host-owned OAuth callback attempt. */
export interface ChatGptLoginAttemptView {
  /** Opaque handle returned by {@link ChatGptLoginTicket}. */
  readonly id: ChatGptLoginAttemptId
  /** Attempt phase; OAuth state, nonce, and verifier are not exposed. */
  readonly phase: 'awaiting-browser' | 'exchanging' | 'complete' | 'failed' | 'cancelled'
  /** Sanitized explanation suitable for an account settings view. */
  readonly message?: string
}

/** Account and pending-login snapshot safe for the Client and SDK consumers. */
export interface ChatGptState {
  /** Connected or reauthentication-required accounts in stable registration order. */
  readonly accounts: readonly ChatGptAccountView[]
  /** Current profile account selection; absent when no usable account is active. */
  readonly activeAccountId?: ChatGptAccountId
  /** Whether any Client has already shown the first-login welcome once. */
  readonly welcomeAcknowledged: boolean
  /** Pending and recently completed sign-in attempts. */
  readonly loginAttempts: readonly ChatGptLoginAttemptView[]
  /** Configured delay between Client state polls while an OAuth callback is pending. */
  readonly loginPollIntervalMs: number
}

/** Browser authorization URL and Host-owned callback handle for a login. */
export interface ChatGptLoginTicket {
  /** Opaque handle used to cancel or inspect the attempt. */
  readonly attemptId: ChatGptLoginAttemptId
  /** Open this URL in the user's system browser; no token is embedded. */
  readonly authorizationUrl: string
}

/** Start a new account registration or reauthorize one saved registration. */
export interface ChatGptLoginRequest {
  /** Existing account to reauthorize; omission starts a new registration. */
  readonly accountId?: ChatGptAccountId
}

/** Result of local logout and the best-effort OpenAI token revocation. */
export interface ChatGptSignOutResult {
  /** Whether OpenAI confirmed revocation of the saved renewable session. */
  readonly revocationConfirmed: boolean
}

/** Address one existing account registration. */
export interface ChatGptAccountRequest {
  /** Account selected by the user. */
  readonly accountId: ChatGptAccountId
}

/** Address one unfinished local sign-in attempt. */
export interface ChatGptCancelLoginRequest {
  /** Opaque Host-generated attempt handle. */
  readonly attemptId: ChatGptLoginAttemptId
}

/** One model capability update; null removes the profile override. */
export interface ChatGptModelConfigUpdate {
  /** A connected account whose catalog currently contains `model`. */
  readonly accountId: ChatGptAccountId
  /** Exact slug from that account's SIWC model catalog. */
  readonly model: string
  /** Complete override to store, or null to clear this model's override. */
  readonly config: ChatGptModelConfig | null
}
