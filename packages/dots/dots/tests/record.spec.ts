import { describe, expect, it } from 'vite-plus/test'
import { decodeDotRecord, decodeDotsDocument } from '../src/record.ts'
import { asDotId } from '../src/ids.ts'
import type { DotRecord } from '../src/types.ts'

/** One complete record used as the mutation base. */
const valid = {
  version: 1,
  id: 'dot-researcher-a1b2c3',
  name: 'researcher',
  purpose: 'Research.',
  directory: '/tmp/dots/dot-researcher-a1b2c3',
  sessionId: 'session-1',
  preset: 'standard',
  createdAt: 1,
  updatedAt: 2,
  assignmentCount: 3,
}

/**
 * Build one record object with an overridden field.
 * @param overrides - fields to replace; `undefined` removes the field.
 * @returns the candidate record.
 */
function withFields(overrides: Record<string, unknown>): Record<string, unknown> {
  const merged = Object.entries({ ...valid, ...overrides }).filter(([, value]) => value !== undefined)
  return Object.fromEntries(merged)
}

describe('decodeDotRecord', () => {
  it('decodes a complete record with every optional field', () => {
    const decoded = decodeDotRecord(
      withFields({
        workspaceId: 'workspace-1',
        permissionPreset: 'workspace-write',
        allowedTools: ['read', 'mcp__github__*'],
        model: { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' },
        lastAssignedAt: 9,
        archivedAt: 10,
      }),
    )
    expect(decoded).toEqual({
      version: 1,
      id: asDotId('dot-researcher-a1b2c3'),
      name: 'researcher',
      purpose: 'Research.',
      directory: '/tmp/dots/dot-researcher-a1b2c3',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      preset: 'standard',
      permissionPreset: 'workspace-write',
      allowedTools: ['read', 'mcp__github__*'],
      model: { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' },
      createdAt: 1,
      updatedAt: 2,
      lastAssignedAt: 9,
      assignmentCount: 3,
      archivedAt: 10,
    })
  })

  it('omits every absent optional field and trims the name', () => {
    const decoded = decodeDotRecord(withFields({ name: '  researcher  ' }))
    expect(decoded.name).toBe('researcher')
    expect(decoded).not.toHaveProperty('workspaceId')
    expect(decoded).not.toHaveProperty('archivedAt')
    expect(decoded).not.toHaveProperty('model')
  })

  it('rejects a non-object and an unsupported version', () => {
    for (const value of [null, 'record', [], 7]) {
      expect(() => decodeDotRecord(value)).toThrow(/not an object/u)
    }
    expect(() => decodeDotRecord(withFields({ version: 2 }))).toThrow(/Unsupported dots registry record version/u)
  })

  it('rejects every required field that is missing or invalid', () => {
    for (const field of ['id', 'name', 'purpose', 'directory', 'sessionId', 'preset']) {
      expect(() => decodeDotRecord(withFields({ [field]: undefined })), field).toThrow(/missing or invalid/u)
      expect(() => decodeDotRecord(withFields({ [field]: 7 })), field).toThrow(/missing or invalid/u)
      expect(() => decodeDotRecord(withFields({ [field]: '' })), field).toThrow(/missing or invalid/u)
    }
    // A blank name reaches the name rules, which reject it with their own message.
    expect(() => decodeDotRecord(withFields({ name: '   ' }))).toThrow(/blank/u)
    expect(() => decodeDotRecord(withFields({ name: 'a/b' }))).toThrow(/path separators/u)
    for (const field of ['createdAt', 'updatedAt']) {
      expect(() => decodeDotRecord(withFields({ [field]: undefined })), field).toThrow(/missing or invalid/u)
      expect(() => decodeDotRecord(withFields({ [field]: 'yesterday' })), field).toThrow(/missing or invalid/u)
    }
  })

  it('rejects an invalid assignment count', () => {
    expect(() => decodeDotRecord(withFields({ assignmentCount: -1 }))).toThrow(/assignmentCount/u)
    expect(() => decodeDotRecord(withFields({ assignmentCount: 1.5 }))).toThrow(/assignmentCount/u)
    expect(() => decodeDotRecord(withFields({ assignmentCount: '3' }))).toThrow(/assignmentCount/u)
  })

  it('rejects invalid optional scalar fields', () => {
    expect(() => decodeDotRecord(withFields({ workspaceId: '' }))).toThrow(/workspaceId/u)
    expect(() => decodeDotRecord(withFields({ workspaceId: 4 }))).toThrow(/workspaceId/u)
    expect(() => decodeDotRecord(withFields({ permissionPreset: '' }))).toThrow(/permissionPreset/u)
    expect(() => decodeDotRecord(withFields({ lastAssignedAt: 'yesterday' }))).toThrow(/lastAssignedAt/u)
    expect(() => decodeDotRecord(withFields({ archivedAt: Number.POSITIVE_INFINITY }))).toThrow(/archivedAt/u)
  })

  it('rejects an invalid allowlist', () => {
    expect(() => decodeDotRecord(withFields({ allowedTools: 'read' }))).toThrow(/allowedTools/u)
    expect(() => decodeDotRecord(withFields({ allowedTools: ['read', ''] }))).toThrow(/allowedTools/u)
    expect(() => decodeDotRecord(withFields({ allowedTools: ['read', 4] }))).toThrow(/allowedTools/u)
    expect(decodeDotRecord(withFields({ allowedTools: [] })).allowedTools).toEqual([])
  })

  it('rejects an invalid stored model', () => {
    expect(() => decodeDotRecord(withFields({ model: 'deepseek' }))).toThrow(/model" is invalid/u)
    expect(() => decodeDotRecord(withFields({ model: [] }))).toThrow(/model" is invalid/u)
    expect(() => decodeDotRecord(withFields({ model: { provider: '', model: 'flash' } }))).toThrow(
      /model provider is invalid/u,
    )
    expect(() => decodeDotRecord(withFields({ model: { provider: 'deepseek', model: '' } }))).toThrow(
      /model id is invalid/u,
    )
    expect(() =>
      decodeDotRecord(withFields({ model: { provider: 'deepseek', model: 'flash', reasoningEffort: 1 } })),
    ).toThrow(/reasoning effort is invalid/u)
    expect(decodeDotRecord(withFields({ model: { provider: 'deepseek', model: 'flash' } })).model).toEqual({
      provider: 'deepseek',
      model: 'flash',
    })
  })
})

describe('decodeDotsDocument', () => {
  it('decodes records in stored order', () => {
    const document = decodeDotsDocument({
      version: 1,
      dots: [valid, { ...valid, id: 'dot-writer-b2c3d4', name: 'writer', sessionId: 'session-2' }],
    })
    expect(document.records.map(record => record.name)).toEqual(['researcher', 'writer'])
  })

  it('rejects a document that is not an object, has a wrong version, or has no records', () => {
    for (const value of [null, 'registry', []]) {
      expect(() => decodeDotsDocument(value)).toThrow(/not an object/u)
    }
    expect(() => decodeDotsDocument({ version: 2, dots: [] })).toThrow(/Unsupported dots registry version/u)
    expect(() => decodeDotsDocument({ version: 1 })).toThrow(/no "dots" array/u)
  })

  it('rejects duplicate identities and duplicate active names', () => {
    expect(() => decodeDotsDocument({ version: 1, dots: [valid, valid] })).toThrow(/Duplicate dot id/u)
    expect(() =>
      decodeDotsDocument({
        version: 1,
        dots: [valid, { ...valid, id: 'dot-other-ffffff', name: 'Researcher' }],
      }),
    ).toThrow(/Duplicate active dot name/u)
  })

  it('admits a repeated name when the earlier record is archived', () => {
    const archived: DotRecord = { ...decodeDotRecord(valid), archivedAt: 5 }
    const document = decodeDotsDocument({
      version: 1,
      dots: [archived, { ...valid, id: 'dot-other-ffffff', name: 'Researcher' }],
    })
    expect(document.records).toHaveLength(2)
  })
})
