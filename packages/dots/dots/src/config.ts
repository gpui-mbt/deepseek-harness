/**
 * Validated deployment configuration for the dots bundle.
 *
 * Every deployment-varying choice is a schema field, so a profile can change
 * the dot root, limits, and preset allowlists from `cordis.yml`. Preset
 * allowlists are validated at activation: a requested preset outside them
 * fails loud instead of producing a dot that cannot run.
 * @module @deepseek-ai/dsh-dots/config
 */

import z from '@deepseek-ai/schemastery'

/** Bundle configuration. */
export interface Config {
  /** Dot root; defaults to `$DSH_HOME/dots`. */
  readonly root?: string
  /** Agent preset used by a new dot when `dot_create` omits one. */
  readonly defaultPreset: string
  /** Permission preset applied to a new dot when `dot_create` omits one. */
  readonly defaultPermissionPreset?: string
  /** Maximum active dots. Defaults to 32. */
  readonly maxDots: number
  /** Maximum UTF-8 bytes in one assignment or memory note. Defaults to 20,000. */
  readonly maxTaskBytes: number
  /** Maximum UTF-8 bytes in a dot purpose. Defaults to 4,000. */
  readonly maxPurposeBytes: number
  /** Maximum UTF-8 bytes of `MEMORY.md` injected into one assignment. Defaults to 8,192. */
  readonly maxMemoryBytes: number
  /** Enforce each dot's `allowedTools` at execution time. Defaults to true. */
  readonly enforceToolAllowlist: boolean
  /** Agent presets a dot may request; an omitted or empty list admits every configured preset. */
  readonly allowedPresets?: readonly string[]
  /** Permission presets a dot may request; an omitted or empty list admits every configured preset. */
  readonly allowedPermissionPresets?: readonly string[]
}

/** Validated configuration schema. Defaults are visible for profile overrides. */
export const Config: z<Partial<Config>, Config> = z.object({
  root: z.string(),
  defaultPreset: z.string().default('standard'),
  defaultPermissionPreset: z.string(),
  maxDots: z.number().step(1).min(1).max(256).default(32),
  maxTaskBytes: z.number().step(1).min(1).max(1_048_576).default(20_000),
  maxPurposeBytes: z.number().step(1).min(1).max(1_048_576).default(4_000),
  maxMemoryBytes: z.number().step(1).min(256).max(1_048_576).default(8_192),
  enforceToolAllowlist: z.boolean().default(true),
  allowedPresets: z.array(z.string()),
  allowedPermissionPresets: z.array(z.string()),
}) as z<Partial<Config>, Config>

/**
 * Reject a configuration whose defaults cannot satisfy its own allowlists.
 * A permitted list that excludes the configured default would create dots the
 * deployment then refuses to run, and a blank default preset names nothing, so
 * activation stops instead.
 * @param config - validated bundle configuration.
 * @throws Error naming the allowlist that excludes its default.
 */
export function validatePresetAllowlists(config: Config): void {
  if (config.defaultPreset.trim().length === 0) {
    throw new Error('dots: defaultPreset must not be blank.')
  }
  const presets = config.allowedPresets
  if (presets !== undefined && presets.length > 0 && !presets.includes(config.defaultPreset)) {
    throw new Error(
      `dots: defaultPreset "${config.defaultPreset}" is not listed in allowedPresets (${presets.join(', ')}).`,
    )
  }
  const permissionPresets = config.allowedPermissionPresets
  const defaultPermissionPreset = config.defaultPermissionPreset
  if (
    permissionPresets !== undefined &&
    permissionPresets.length > 0 &&
    defaultPermissionPreset !== undefined &&
    !permissionPresets.includes(defaultPermissionPreset)
  ) {
    throw new Error(
      `dots: defaultPermissionPreset "${defaultPermissionPreset}" is not listed in allowedPermissionPresets (${permissionPresets.join(', ')}).`,
    )
  }
}

/**
 * Check one requested agent preset against the deployment allowlist.
 * @param config - validated bundle configuration.
 * @param preset - requested agent preset.
 * @returns the resolved preset.
 * @throws Error naming the allowlist when the request is not admitted.
 */
export function requireAllowedPreset(config: Config, preset: string): string {
  const allowed = config.allowedPresets
  if (allowed !== undefined && allowed.length > 0 && !allowed.includes(preset)) {
    throw new Error(`Agent preset "${preset}" is not allowed on this deployment. Allowed: ${allowed.join(', ')}.`)
  }
  return preset
}

/**
 * Check one requested permission preset against the deployment allowlist.
 * @param config - validated bundle configuration.
 * @param preset - requested permission preset, or undefined when none is requested.
 * @returns the resolved permission preset.
 * @throws Error naming the allowlist when the request is not admitted.
 */
export function requireAllowedPermissionPreset(config: Config, preset: string | undefined): string | undefined {
  if (preset === undefined) return undefined
  const allowed = config.allowedPermissionPresets
  if (allowed !== undefined && allowed.length > 0 && !allowed.includes(preset)) {
    throw new Error(
      `Permission preset "${preset}" is not allowed on this deployment. Allowed: ${allowed.join(', ')}.`,
    )
  }
  return preset
}
