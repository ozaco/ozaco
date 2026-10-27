import type { Operation } from 'std:effect'

import { CHANGES_PREFIX, FIELDS } from '../const'
import type { Adapter } from '../types/adapter'
import type { Database } from '../types/database'
import type { Helpers } from '../types/helpers'
import type { Schema } from '../types/schema'
import type { Spec } from '../types/spec'
import { where } from '../utils/filter'
import { isDestructive, isSystemField } from '../utils/is'

import { isLogName } from './log'

/** How many `null` rows one backfill page reads before writing them. */
const BACKFILL_PAGE = 500

/** The reconcile steps for one table, given its live shape (or `null` when absent). */
const stepsFor = (
  spec: Spec.Table,
  shape: Adapter.Shape | null,
  alterColumn: boolean,
): Spec.Step[] => {
  const indexSteps = spec.indexes.map((index): Spec.Step => ({
    kind: 'create-index',
    table: spec.name,
    index,
  }))

  if (!shape) {
    return [{ kind: 'create-table', table: spec }, ...indexSteps]
  }

  const existing = new Map(shape.columns.map(column => [column.name, column]))
  const declared = new Set(spec.columns.map(column => column.name))
  const steps: Spec.Step[] = []

  for (const column of spec.columns) {
    const live = existing.get(column.name)

    if (!live) {
      steps.push({ kind: 'add-column', table: spec.name, column })
    } else if (live.type !== null && live.expected !== null && live.type !== live.expected) {
      // the column exists with another type: drift. Cast in place where the backend can
      steps.push({
        kind: 'alter-column',
        table: spec.name,
        column,
        from: live.type,
        unsupported: !alterColumn,
      })
    }
  }

  for (const live of shape.columns) {
    if (!declared.has(live.name) && !isSystemField(live.name)) {
      steps.push({ kind: 'drop-column', table: spec.name, column: live.name })
    }
  }

  return [...steps, ...indexSteps]
}

/** Whether `migrate()` may run a step: never an unsupported retype; in safe mode nothing that
 * destroys or rewrites data. */
const applicable = (safe: boolean, step: Spec.Step): boolean => {
  if (step.kind === 'alter-column' && step.unsupported) {
    return false
  }

  return !safe || !isDestructive(step)
}

/**
 * What the storage holds that the schema no longer declares — ONLY what this library itself
 * created: a change log is the proof. An undeclared table with a `__changes_` log was once
 * declared here and gets dropped together with its log; a log whose table is gone is an orphan
 * and gets dropped too. A foreign table (no log) is never touched. All of it is destructive:
 * `safe: true` skips it, `planMigration` shows it.
 */
const leftoversOf = (state: Helpers.Reconciler, live: readonly string[]): Spec.Step[] => {
  const present = new Set(live)
  const declared = new Set(state.specs.keys())
  const steps: Spec.Step[] = []

  for (const name of live) {
    if (!isLogName(name) || !name.startsWith(CHANGES_PREFIX)) {
      continue
    }

    const base = name.slice(CHANGES_PREFIX.length)

    if (declared.has(base)) {
      continue
    }

    if (present.has(base)) {
      steps.push({ kind: 'drop-table', table: base })
    }

    steps.push({ kind: 'drop-table', table: name })
  }

  return steps
}

/**
 * Compute (without executing) the reconcile from the live storage to the declared schema: create
 * missing tables, add missing columns (system columns included), retype drifted ones, drop
 * undeclared ones, and (re)declare indexes (adapters treat create steps as idempotent).
 */
export function* planMigration(state: Helpers.Reconciler) {
  const steps: Spec.Step[] = []
  const { alterColumn } = state.info.capabilities

  // every declared table travels with its hidden change log
  for (const [name, spec] of state.specs) {
    const base = yield* state.adapter.introspect(spec)

    steps.push(...stepsFor(spec, base, alterColumn))

    const log = state.logs.get(name)

    if (!log) {
      continue
    }

    let shape = yield* state.adapter.introspect(log)

    if (!base && shape) {
      // the table vanished behind our back but its history did not: a recreated table starts
      // with a fresh log (destructive → reported only under `safe`)
      steps.push({ kind: 'drop-table', table: log.name })
      shape = null
    }

    steps.push(...stepsFor(log, shape, alterColumn))
  }

  steps.push(...leftoversOf(state, yield* state.adapter.tables()))

  return { steps } as Spec.Plan
}

/** Execute a plan. Unsupported retypes are always skipped (they were reported by the plan); in
 * safe mode so are the destructive steps. */
export function* applyPlan(state: Helpers.Reconciler, plan: Spec.Plan) {
  const steps = plan.steps.filter(step => applicable(state.safe, step))

  if (steps.length > 0) {
    yield* state.adapter.migrate(steps)
  }
}

/**
 * Apply the insert-time default of every REQUIRED column that has one to the rows holding `null`
 * there (`DbClient.use({ backfill: true })`): a column added after the rows were written comes
 * back empty from the adapter, and a required column reading `null` fails every output check
 * downstream. Through the handle, page by page — every row is written like any other write. A
 * default that answers `null` itself is left alone; an optional column keeps its `null`s.
 */
export function* backfillDefaults(
  handle: Database.Handle,
  tables: readonly Schema.Table[],
): Operation<number> {
  let filled = 0

  for (const def of tables) {
    for (const column of def.columns) {
      const make = def.defaults[column.name]
      const sample = make?.()

      if (!make || column.optional || sample === null || sample === undefined) {
        continue
      }

      for (;;) {
        const stale = yield* handle
          .query(def.name)
          .filter(where.isNull(column.name))
          .take(BACKFILL_PAGE)

        if (stale.length === 0) {
          break
        }

        for (const row of stale) {
          yield* handle.patch(def.name, (row as Spec.Doc)[FIELDS.id] as string, {
            [column.name]: make(),
          })

          filled += 1
        }
      }
    }
  }

  return filled
}
