import { DbClient, eq, lt } from 'db:core'
import { useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DEFAULT_OUTCOME_TTL_MS } from '../const'
import { ServerErrors } from '../errors'
import { OutcomesDbRef, OutcomesMemoryRef } from '../internal/context'
import type { OutcomesDef } from '../types/outcomes'
import { outcomesDefaults } from '../utils/defaults'
import { outcomesTable } from '../utils/outcomes'

import { Outcomes } from './protocol'

/** The in-process outcome store (the default `createServer` installs). */
export const MemoryOutcomes: OutcomesDef.Handle = Outcomes.implement<
  OutcomesDef.Options,
  [options?: { readonly ttlMs?: number | undefined }]
>({
  name: 'server-outcomes-memory',
  version: '0.5.0',
  description: 'In-process outcome records',

  *setup(options) {
    const ttlMs = options?.ttlMs ?? DEFAULT_OUTCOME_TTL_MS
    yield* OutcomesMemoryRef.set({ rows: new Map(), ttlMs })
    return { store: 'memory', ttlMs }
  },
}).build({
  ...outcomesDefaults(),
  *put(outcome) {
    ;(yield* useContext(OutcomesMemoryRef)).rows.set(outcome.cid, outcome)
  },
  *get(cid) {
    const state = yield* useContext(OutcomesMemoryRef)
    const row = state.rows.get(cid)
    if (!row) {
      return null
    }
    if (Date.now() - row.ts > state.ttlMs) {
      state.rows.delete(cid)
      return null
    }
    return row
  },
  *prune() {
    const state = yield* useContext(OutcomesMemoryRef)
    const floor = Date.now() - state.ttlMs
    let removed = 0
    for (const [cid, row] of state.rows) {
      if (row.ts < floor) {
        state.rows.delete(cid)
        removed += 1
      }
    }
    return removed
  },
})

/** Outcome records in the installed database (`_ob_outcomes`): what a restarted caller can
 * reconcile against. Install `DbClient` with {@link outcomesTable} declared before this. */
export const DbOutcomes: OutcomesDef.Handle = Outcomes.implement<
  OutcomesDef.Options,
  [options?: { readonly ttlMs?: number | undefined }]
>({
  name: 'server-outcomes-db',
  version: '0.5.0',
  description: 'Outcome records in the database',

  *setup(options) {
    const db = yield* DbClient.context.get()
    if (!db) {
      return yield* fail(
        ServerErrors.Configuration,
        'DbOutcomes needs a DbClient (declaring `outcomesTable`) installed before it',
      )
    }
    const ttlMs = options?.ttlMs ?? DEFAULT_OUTCOME_TTL_MS
    yield* OutcomesDbRef.set({ ttlMs })
    return { store: 'db', ttlMs }
  },
}).build({
  ...outcomesDefaults(),
  *put(outcome) {
    const db = (yield* DbClient.context.expect()) as AnyType
    const existing = yield* db.query(outcomesTable.name).filter(eq('cid', outcome.cid)).first()
    if (existing) {
      yield* db.patch(outcomesTable.name, String(existing._id), {
        state: outcome.state,
        error: outcome.error ?? undefined,
        ts: outcome.ts,
      })
      return
    }
    yield* db.insert(outcomesTable.name, {
      cid: outcome.cid,
      state: outcome.state,
      service_id: outcome.service_id,
      action_id: outcome.action_id,
      error: outcome.error ?? undefined,
      ts: outcome.ts,
    })
  },
  *get(cid) {
    const db = (yield* DbClient.context.expect()) as AnyType
    const state = yield* useContext(OutcomesDbRef)
    const row = yield* db.query(outcomesTable.name).filter(eq('cid', cid)).first()
    if (!row || Date.now() - Number(row.ts) > state.ttlMs) {
      return null
    }
    return {
      cid: String(row.cid),
      state: row.state,
      service_id: String(row.service_id),
      action_id: String(row.action_id),
      error: row.error ?? null,
      ts: Number(row.ts),
    }
  },
  *prune() {
    const db = (yield* DbClient.context.expect()) as AnyType
    const state = yield* useContext(OutcomesDbRef)
    const stale = yield* db
      .query(outcomesTable.name)
      .filter(lt('ts', Date.now() - state.ttlMs))
      .collect()
    for (const row of stale) {
      yield* db.delete(outcomesTable.name, String(row._id))
    }
    return stale.length
  },
})
