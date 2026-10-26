/**
 * Validation of persisted dot records.
 *
 * Records reach this package from two durable boundaries: the `dots` storage
 * domain table and the legacy `registry.json` file. Both must apply the same
 * checks, so every read passes through {@link decodeDotRecord} before the
 * lifecycle sees it. Invalid stored data fails loud; it is never repaired in
 * place.
 * @module @deepseek-ai/dsh-dots/record
 */

import { DotError } from './errors.ts'
import { asDotId } from './ids.ts'
import { normalizeName } from './paths.ts'
import type { DotModelSelection, DotRecord } from './types.ts'

/** One decoded legacy `registry.json` document. */
export interface DotsDocument {
  /** Records in stored order. */
  readonly records: readonly DotRecord[]
}

/**
 * Read one required string field.
 * @param row - decoded record object.
 * @param key - field name.
 * @returns the non-empty string.
 */
function stringField(row: Record<string, unknown>, key: string): string {
  const field = row[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new DotError('dots/registry-corrupt', `Dots registry record field "${key}" is missing or invalid.`)
  }
  return field
}

/**
 * Read one required finite number field.
 * @param row - decoded record object.
 * @param key - field name.
 * @returns the number.
 */
function numberField(row: Record<string, unknown>, key: string): number {
  const field = row[key]
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new DotError('dots/registry-corrupt', `Dots registry record field "${key}" is missing or invalid.`)
  }
  return field
}

/**
 * Read one optional non-empty string field.
 * @param row - decoded record object.
 * @param key - field name.
 * @returns the string, or undefined when the field is absent.
 */
function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const field = row[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.length === 0) {
    throw new DotError('dots/registry-corrupt', `Dots registry record field "${key}" is invalid.`)
  }
  return field
}

/**
 * Read one optional finite number field.
 * @param row - decoded record object.
 * @param key - field name.
 * @returns the number, or undefined when the field is absent.
 */
function optionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const field = row[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw new DotError('dots/registry-corrupt', `Dots registry record field "${key}" is invalid.`)
  }
  return field
}

/**
 * Decode the optional execution allowlist.
 * @param field - decoded field value.
 * @returns a frozen normalized copy, or undefined when absent.
 */
function decodeAllowedTools(field: unknown): readonly string[] | undefined {
  if (field === undefined) return undefined
  if (!Array.isArray(field)) {
    throw new DotError('dots/registry-corrupt', 'Dots registry record field "allowedTools" is invalid.')
  }
  const tools: string[] = []
  for (const item of field) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new DotError('dots/registry-corrupt', 'Dots registry record field "allowedTools" is invalid.')
    }
    tools.push(item)
  }
  return Object.freeze(tools)
}

/**
 * Decode the optional model selection.
 * @param field - decoded field value.
 * @returns a frozen selection, or undefined when absent.
 */
function decodeModel(field: unknown): DotModelSelection | undefined {
  if (field === undefined) return undefined
  if (typeof field !== 'object' || field === null || Array.isArray(field)) {
    throw new DotError('dots/registry-corrupt', 'Dots registry record field "model" is invalid.')
  }
  const value = field as Record<string, unknown>
  if (typeof value.provider !== 'string' || value.provider.length === 0) {
    throw new DotError('dots/registry-corrupt', 'Dots registry record model provider is invalid.')
  }
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw new DotError('dots/registry-corrupt', 'Dots registry record model id is invalid.')
  }
  if (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string') {
    throw new DotError('dots/registry-corrupt', 'Dots registry record reasoning effort is invalid.')
  }
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  }) satisfies DotModelSelection
}

/**
 * Validate one stored dot record.
 * @param value - decoded JSON value.
 * @returns the validated record.
 * @throws DotError `dots/registry-corrupt` when a required field is invalid.
 */
export function decodeDotRecord(value: unknown): DotRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DotError('dots/registry-corrupt', 'A dots registry record is not an object.')
  }
  const row = value as Record<string, unknown>
  if (row.version !== 1) {
    throw new DotError(
      'dots/registry-corrupt',
      `Unsupported dots registry record version: ${String(row.version)}.`,
    )
  }
  const allowedTools = decodeAllowedTools(row.allowedTools)
  const model = decodeModel(row.model)
  const assignmentCount = numberField(row, 'assignmentCount')
  if (!Number.isSafeInteger(assignmentCount) || assignmentCount < 0) {
    throw new DotError('dots/registry-corrupt', 'Dots registry record field "assignmentCount" is invalid.')
  }
  const workspaceId = optionalString(row, 'workspaceId')
  const permissionPreset = optionalString(row, 'permissionPreset')
  const lastAssignedAt = optionalNumber(row, 'lastAssignedAt')
  const archivedAt = optionalNumber(row, 'archivedAt')
  return {
    version: 1,
    id: asDotId(stringField(row, 'id')),
    name: normalizeName(stringField(row, 'name')),
    purpose: stringField(row, 'purpose'),
    directory: stringField(row, 'directory'),
    sessionId: stringField(row, 'sessionId'),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    preset: stringField(row, 'preset'),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(model === undefined ? {} : { model }),
    createdAt: numberField(row, 'createdAt'),
    updatedAt: numberField(row, 'updatedAt'),
    ...(lastAssignedAt === undefined ? {} : { lastAssignedAt }),
    assignmentCount,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  }
}

/**
 * Validate one decoded legacy registry document.
 * @param value - parsed JSON.
 * @returns records in stored order.
 * @throws DotError `dots/registry-corrupt` for a wrong version, a missing record
 *   list, a duplicate id, or two active dots sharing a name.
 */
export function decodeDotsDocument(value: unknown): DotsDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DotError('dots/registry-corrupt', 'Dots registry is not an object.')
  }
  const document = value as Record<string, unknown>
  if (document.version !== 1) {
    throw new DotError('dots/registry-corrupt', `Unsupported dots registry version: ${String(document.version)}.`)
  }
  if (!Array.isArray(document.dots)) {
    throw new DotError('dots/registry-corrupt', 'Dots registry has no "dots" array.')
  }
  const records = document.dots.map(decodeDotRecord)
  const ids = new Set<string>()
  const activeNames = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new DotError('dots/registry-corrupt', `Duplicate dot id "${record.id}" in registry.`)
    }
    ids.add(record.id)
    if (record.archivedAt === undefined) {
      const key = record.name.toLocaleLowerCase()
      if (activeNames.has(key)) {
        throw new DotError('dots/registry-corrupt', `Duplicate active dot name "${record.name}" in registry.`)
      }
      activeNames.add(key)
    }
  }
  return { records }
}
