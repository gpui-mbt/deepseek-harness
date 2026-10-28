/**
 * Branding helpers for dot identities.
 * @module @deepseek-ai/dsh-dots/ids
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { DotId } from './types.ts'

/**
 * Brand one stored or requested dot identity.
 * @param value - dot identity string admitted by this package.
 * @returns the same string carrying the compile-time dot-id brand.
 */
export function asDotId(value: string): DotId {
  return brandString<DotId>(value)
}
