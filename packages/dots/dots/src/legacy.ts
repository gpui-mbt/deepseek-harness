/**
 * One-time import of the retired JSON-file registry.
 *
 * Earlier deployments stored dot records in `registry.json`. The storage
 * domain is now authoritative, so activation imports that file exactly once:
 * only while the table is empty and every record passes validation. The source
 * moves to `registry.json.importing` before any durable row writes; an interrupted
 * import resumes from that journal before activation can publish the registry.
 * Completion moves the journal to `registry.json.imported`. Unjournaled files
 * beside existing data are reported, never merged or deleted.
 * @module @deepseek-ai/dsh-dots/legacy
 */

import { open, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
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
export async function importLegacyRegistry(table: KvTable<DotId, DotRecord>, file: string): Promise<LegacyImportResult> {
  const pending = `${file}.importing`
  let text: string
  let recovering = true
  try {
    text = await readFile(pending, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DotError('dots/unavailable', `Could not read pending dots import at ${pending}: ${String(error)}`)
    }
    recovering = false
    try {
      text = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { imported: 0, leftInPlace: false }
      throw new DotError('dots/unavailable', `Could not read the dots registry at ${file}: ${String(error)}`)
    }
    if (table.size > 0) return { imported: 0, leftInPlace: true }
  }
  if (recovering) {
    try {
      await stat(file)
      throw new DotError('dots/registry-corrupt', `Both ${file} and ${pending} exist; resolve the ambiguous import before activation.`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new DotError('dots/registry-corrupt', `Dots registry at ${file} is not valid JSON: ${String(error)}`)
  }
  const { records } = decodeDotsDocument(parsed)
  // The source itself is the durable journal. Publish it before the first
  // table write, then recover only an exact prefix/subset of this document.
  if (!recovering) await moveRegistry(file, pending)
  for (const [id, current] of table.entries()) {
    const expected = records.find(record => record.id === id)
    if (expected === undefined || !isDeepStrictEqual(current, expected)) {
      throw new DotError('dots/registry-corrupt', `Pending dots import conflicts with stored record ${id}; activation is blocked.`)
    }
  }
  for (const record of records) {
    if (table.get(record.id) === undefined) await table.put(record.id, record)
  }
  await moveRegistry(pending, `${file}${IMPORTED_REGISTRY_SUFFIX}`)
  return { imported: records.length, leftInPlace: false }
}

/** Rename the import journal and durably publish the directory entry. */
async function moveRegistry(source: string, target: string): Promise<void> {
  try {
    try {
      const previous = await readFile(target, 'utf8')
      if (previous !== (await readFile(source, 'utf8'))) throw new Error(`Existing destination ${target} differs; preserving both files`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(source, target)
    // Windows does not expose directory fsync; rename still provides its atomic
    // namespace transition. Other platforms must finish it before any writes.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(source), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error: unknown) {
    throw new DotError('dots/unavailable', `Could not move dots registry from ${source} to ${target}: ${String(error)}`)
  }
}
