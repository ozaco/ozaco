// oxlint-disable import/exports-last
import type { Flow, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { FIELDS } from '../const'
import type { Change } from '../types/change'
import type { Helpers } from '../types/helpers'
import type { Spec } from '../types/spec'

/** A table-level touch (empty id) means "anything here may have changed" — every watcher of the
 * table re-reads. */
const isTableTouch = (event: Change.Event): boolean => event.op === 'touch' && event.id === ''

/**
 * Watch one document: its current value immediately, then a fresh read after every change to it
 * (events carry no documents). A `delete` yields `null` without reading.
 */
export const watchDoc = (input: Helpers.DocWatch): Flow<Spec.Doc | null, never> => ({
  *[Symbol.iterator]() {
    const subscription = yield* input.hub.changes(input.table)
    let primed = false

    return {
      *next() {
        if (!primed) {
          primed = true
          return { done: false as const, value: yield* input.load() }
        }
        for (;;) {
          const step = yield* subscription.next()
          if (step.done) {
            continue
          }
          const event = step.value
          if (event.id !== input.id && !isTableTouch(event)) {
            continue
          }
          if (event.op === 'delete') {
            return { done: false as const, value: null }
          }
          return { done: false as const, value: yield* input.load() }
        }
      },
    }
  },
})

const isEmptyDelta = (delta: Change.Delta): boolean =>
  delta.added.length === 0 && delta.changed.length === 0 && delta.removed.length === 0

/**
 * A live view of a query. Every relevant committed change triggers ONE recompute (events queued
 * before the last recompute's arrival cursor coalesce away); an event that provably cannot change
 * the result is skipped without touching the database:
 * - a `delete` of a row not in the result,
 * - an `update` of a row not in the result whose changed `fields` touch neither the filter nor
 *   the order columns (a `fields`-less update is "unknown" → recompute).
 */
export const watchQuery = (input: Helpers.QueryWatch): Flow<AnyType, never> => ({
  *[Symbol.iterator]() {
    const subscription = yield* input.hub.changes(input.table)
    // the hub's arrival cursor when we subscribed: the k-th event this subscription consumes is
    // hub arrival `arrived + k` (the buffered subscription sees every event from here on)
    let arrived = input.hub.arrival(input.table)
    const mode = input.options?.mode ?? 'snapshot'
    // ids + row tokens of the last computed result — powers delta diffing and the skip rules
    let known: Map<string, string> | null = null
    // the hub's arrival cursor at the last recompute: queued events at or below it are already
    // reflected (the coalescing that makes a transaction burst ONE emission)
    let computed = -1
    let token = input.hub.version(input.table)

    const recompute = function* (): Operation<Helpers.WatchComputation> {
      // capture BEFORE the read: anything applied after this point recomputes again
      computed = input.hub.arrival(input.table)
      token = input.hub.version(input.table)
      const rows = yield* input.load()
      const next = new Map<string, string>()
      const added: Spec.Doc[] = []
      const changed: Spec.Doc[] = []
      for (const row of rows) {
        const id = String(row[FIELDS.id])
        const version = String(row[FIELDS.version] ?? '')
        next.set(id, version)
        if (!known) {
          continue
        }
        const before = known.get(id)
        if (before === undefined) {
          added.push(row)
        } else if (before !== version) {
          changed.push(row)
        }
      }
      const removed = known ? [...known.keys()].filter(id => !next.has(id)) : []
      const delta: Change.Delta = known
        ? { added, changed, removed, token }
        : { added: [...rows], changed: [], removed: [], token }
      known = next
      return { rows, delta }
    }

    const emission = (result: Helpers.WatchComputation) =>
      mode === 'delta' ? result.delta : { rows: result.rows, token }

    /** true when the event provably cannot change this query's result. */
    const skippable = (event: Change.Event): boolean => {
      if (!known || event.op === 'touch' || event.id === '' || known.has(event.id)) {
        return false
      }
      if (event.op === 'delete') {
        return true
      }
      if (event.op === 'update' && event.fields) {
        return !event.fields.some(field => input.fields.has(field))
      }
      return false
    }

    let primed = false
    return {
      *next() {
        if (!primed) {
          primed = true
          // `since` is answered by the change log — valid from any node; a consumer that is
          // provably current gets no initial emission (the baseline is still computed for diffs)
          const verdict =
            input.options?.since === undefined
              ? 'snapshot'
              : yield* input.resolve(input.options.since)
          const initial = yield* recompute()
          if (verdict !== 'skip') {
            return { done: false as const, value: { ...emission(initial), baseline: true } }
          }
        }
        for (;;) {
          const step = yield* subscription.next()
          if (step.done) {
            continue
          }
          arrived += 1
          const event = step.value
          if (arrived <= computed || skippable(event)) {
            continue
          }
          const result = yield* recompute()
          if (mode === 'delta' && isEmptyDelta(result.delta)) {
            continue
          }
          return { done: false as const, value: emission(result) }
        }
      },
    }
  },
})
