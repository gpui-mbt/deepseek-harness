/**
 * One-time import of the retired JSON-file registry.
 *
 * Earlier deployments stored dot records in `registry.json`. The storage
 * domain is now authoritative, so activation imports that file exactly once:
 * only while the table is empty, only after every record passes the durable
 * record checks, and only then by renaming the file to
 * `registry.json.imported`. A file that survives beside a non-empty table is
 * reported, never merged or deleted.
 * @module @deepseek-ai/dsh-dots/legacy
 */

import { readFile, rename } from 'node:fs/promises'
import { DotError } from './errors.ts'
import { decodeDotsDocument } from './record.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { DotId, DotRecord } from './types.ts'

/** Suffix applied to an imported legacy registry file. */
export const IMPORTED_REGISTRY_SUFFIX = '.imported'

/** Outcome of one legacy-registry import attempt. */
export interface LegacyImportResult {
  /** Number of records written into the table. */
  readonly imported: number
  /** Whether a legacy file was present while the table already held records. */
  readonly leftInPlace: boolean
}

/**
 * Import the legacy registry file into the dots table.
 * @param table - the `dots` table of the open domain.
 * @param file - absolute path of the legacy `registry.json`.
 * @returns how many records were imported, and whether a leftover file was left alone.
 * @throws DotError `dots/registry-corrupt` for an unreadable document and
 *   `dots/unavailable` when reading or renaming the file fails.
 */
export async function importLegacyRegistry(
  table: KvTable<DotId, DotRecord>,
  file: string,
): Promise<LegacyImportResult> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { imported: 0, leftInPlace: false }
    throw new DotError('dots/unavailable', `Could not read the dots registry at ${file}: ${String(error)}`)
  }
  // The table is authoritative once it holds a record: a leftover file keeps its
  // own bytes so an operator can integrate it by hand.
  if (table.size > 0) return { imported: 0, leftInPlace: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new DotError('dots/registry-corrupt', `Dots registry at ${file} is not valid JSON: ${String(error)}`)
  }
  const { records } = decodeDotsDocument(parsed)
  for (const record of records) {
    await table.put(record.id, record)
  }
  try {
    await rename(file, `${file}${IMPORTED_REGISTRY_SUFFIX}`)
  } catch (error: unknown) {
    throw new DotError(
      'dots/unavailable',
      `Imported the dots registry at ${file} but could not rename it to ${file}${IMPORTED_REGISTRY_SUFFIX}: ${String(error)}`,
    )
  }
  return { imported: records.length, leftInPlace: false }
}
