/**
 * Durable dots storage declared as a storage domain.
 *
 * One domain named `dots` holds one table named `dots`, keyed by {@link DotId}
 * and valued by the complete {@link DotRecord}. Stored values are validated by
 * the same decoder the legacy registry import uses, so a malformed row rejects
 * opening the domain instead of entering the lifecycle.
 * @module @deepseek-ai/dsh-dots/storage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeDotRecord } from './record.ts'
import type { DotId, DotRecord } from './types.ts'

/**
 * Record schema that delegates to {@link decodeDotRecord}.
 * A `dots/registry-corrupt` failure becomes a zod issue carrying its message.
 */
const dotRecordSchema = z.unknown().transform((value, context): DotRecord => {
  try {
    return decodeDotRecord(value)
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: String(error) })
  }
  return z.NEVER
})

/** Authoritative dots storage; malformed records reject opening the domain. */
export const dotsDomain = defineDomain({
  name: 'dots',
  version: 1,
  tables: { dots: domainTable<DotId, DotRecord>(dotRecordSchema) },
})
