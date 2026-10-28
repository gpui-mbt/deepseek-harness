/**
 * The durable dot record set, backed by the `dots` storage domain table.
 *
 * The store owns resolution rules (id first, then active name, then archived
 * name), the active-dot cap, and serialized mutations. It performs no Session
 * or filesystem work; the lifecycle controller owns those.
 * @module @deepseek-ai/dsh-dots/store
 */

import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { DotError } from './errors.ts'
import { asDotId } from './ids.ts'
import type { dotsDomain } from './storage.ts'
import type { DotId, DotRecord } from './types.ts'

/** One durable dot record set over the open `dots` domain. */
export class DotStore {
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param domain - the open `dots` domain.
   */
  constructor(private readonly domain: Domain<typeof dotsDomain>) {}

  /** The single `dots` table handle. */
  private get table() {
    return this.domain.table('dots')
  }

  /**
   * Read stored records in storage order.
   * @param includeArchived - include archived records.
   * @returns a detached array of records.
   */
  list(includeArchived = false): DotRecord[] {
    const records = [...this.table.entries()].map(([, record]) => record)
    return includeArchived ? records : records.filter(record => record.archivedAt === undefined)
  }

  /**
   * Resolve a dot by exact id or case-insensitive name.
   * @param ref - id or name.
   * @returns the record, or undefined when nothing matches.
   */
  find(ref: string): DotRecord | undefined {
    const byId = this.table.get(asDotId(ref))
    if (byId !== undefined) return byId
    const key = ref.trim().toLocaleLowerCase()
    const records = this.list(true)
    const active = records.find(record => record.archivedAt === undefined && record.name.toLocaleLowerCase() === key)
    if (active !== undefined) return active
    return records.find(record => record.name.toLocaleLowerCase() === key)
  }

  /**
   * Resolve a dot by its home Session identity.
   * @param sessionId - home Session identity.
   * @returns the record, or undefined when no dot owns that Session.
   */
  findBySession(sessionId: string): DotRecord | undefined {
    return this.list(true).find(record => record.sessionId === sessionId)
  }

  /**
   * Store one new active dot.
   * @param record - complete record.
   * @param maxDots - maximum active dots.
   * @returns the stored record.
   * @throws DotError `dots/limit` or `dots/conflict` when a rule refuses the record.
   */
  async add(record: DotRecord, maxDots: number): Promise<DotRecord> {
    return await this.enqueue(async () => {
      const current = this.list(true)
      const active = current.filter(item => item.archivedAt === undefined)
      if (record.archivedAt === undefined && active.length >= maxDots) {
        throw new DotError('dots/limit', `The dot limit (${maxDots}) has been reached.`)
      }
      const key = record.name.toLocaleLowerCase()
      if (record.archivedAt === undefined && active.some(item => item.name.toLocaleLowerCase() === key)) {
        throw new DotError('dots/conflict', `A dot named "${record.name}" already exists.`)
      }
      if (current.some(item => item.id === record.id)) {
        throw new DotError('dots/conflict', `Dot id "${record.id}" already exists.`)
      }
      await this.table.put(record.id, record)
      return record
    })
  }

  /**
   * Replace one active record through a pure mutation.
   * @param id - record identity.
   * @param mutate - receives the current record and returns the next one.
   * @returns the stored record.
   * @throws DotError `dots/not-found` for an unknown or archived id, `dots/invalid`
   *   when the mutation changes the identity or name.
   */
  async update(id: DotId, mutate: (record: DotRecord) => DotRecord): Promise<DotRecord> {
    return await this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined || current.archivedAt !== undefined) {
        throw new DotError('dots/not-found', `No active dot with id "${id}" exists.`)
      }
      const next = mutate(current)
      if (next.id !== current.id || next.name !== current.name) {
        throw new DotError('dots/invalid', 'A dot update may not change its identity or name.')
      }
      await this.table.put(id, next)
      return next
    })
  }

  /**
   * Archive one dot. Idempotent for an already archived id.
   * @param id - record identity.
   * @param archivedAt - millisecond timestamp.
   * @returns the archived record.
   * @throws DotError `dots/not-found` for an unknown id.
   */
  async archive(id: DotId, archivedAt: number): Promise<DotRecord> {
    return await this.enqueue(async () => {
      const current = this.table.get(id)
      if (current === undefined) {
        throw new DotError('dots/not-found', `No dot with id "${id}" exists.`)
      }
      if (current.archivedAt !== undefined) return current
      const next: DotRecord = { ...current, archivedAt, updatedAt: archivedAt }
      await this.table.put(id, next)
      return next
    })
  }

  /**
   * Serialize one mutation behind all earlier mutations.
   * @param operation - mutation body.
   * @returns the operation result.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
