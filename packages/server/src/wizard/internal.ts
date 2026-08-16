import { clampLimit, Db, eq, sanitizeFilter, SYSTEM_NAMES } from 'db:core'
import type { Database, FilterValue, QueryHandle, TableDef } from 'db:core'
import {
  CallContext,
  CoreErrors,
  defineAction,
  RequestContext,
  ResponseContext,
  rootTrace,
  TraceContext,
  useRequest,
} from 'server:core'
import type { Action, Meta } from 'server:core'
import { attempt, operation, scoped } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import { WizardErrors } from './errors'
import type { AccessGuard, Wizard, WizardFn } from './types'

const parseFilter = operation(function* (text: string) {
  const parsed = yield* attempt(() => JsonCodec.actions.parse(text))

  if (isFailure(parsed)) {
    return yield* fail(WizardErrors.BadFilter, 'the "filter" parameter is not valid JSON')
  }

  return parsed.value
})

/** Coerce a query-param facet string by its column kind (WS args arrive already typed). */
const facetValue = (table: TableDef, field: string, value: unknown): FilterValue => {
  if (typeof value !== 'string') {
    return value as FilterValue
  }

  const kind = table.columns.find(column => column.name === field)?.kind

  if (kind === 'int' || kind === 'float') {
    return Number(value)
  }

  if (kind === 'boolean') {
    return value === 'true' || value === '1'
  }

  return value
}

const guarded = (fn: WizardFn): ((args: AnyType) => Operation<AnyType>) => {
  const { access, handler } = fn

  if (!access) {
    return handler
  }

  return operation(function* (args: AnyType) {
    const allowed = yield* access()

    if (!allowed) {
      return yield* fail(CoreErrors.Forbidden, 'access denied')
    }

    return yield* handler(args)
  })
}

/** The installed database as an untyped handle (wizard fns are compiled schema-generically). */
export const database = (): Operation<Database> => Db.context.expect()

/** Wire-allowed filter fields of a table: the declared columns plus the system fields. */
export const filterFields = (table: TableDef): readonly string[] => [
  ...new Set([...table.columns.map(column => column.name), ...SYSTEM_NAMES]),
]

/**
 * args → the sanitized, faceted, ordered (unpaginated) query — the ONE pipeline shared by the REST
 * `list` handler (which paginates it) and the realtime watch (which deltas it).
 */
export const listQuery = operation(function* (
  pipeline: Wizard.ListPipeline,
  args: Record<string, unknown>,
) {
  const db = yield* database()
  const { table } = pipeline
  let handle = db.query(table.name) as QueryHandle<AnyType>

  const raw = args['filter']

  if (raw !== undefined && raw !== null && raw !== '') {
    const input = typeof raw === 'string' ? yield* parseFilter(raw) : raw
    const clean = yield* sanitizeFilter(input, { fields: filterFields(table) })

    handle = handle.filter(clean)
  }

  for (const facet of pipeline.filters) {
    const value = args[facet]

    if (value !== undefined && value !== '') {
      handle = handle.filter(eq(facet, facetValue(table, facet, value)))
    }
  }

  const order = args['order']

  if (typeof order === 'string' && order !== '') {
    handle = handle.order(order, args['direction'] === 'desc' ? 'desc' : 'asc')
  }

  return handle
})

/** Resolve the page size: absent → the default page size; present → clamped into [1, max]. */
export const limitOf = (pipeline: Wizard.ListPipeline, args: Record<string, unknown>): number => {
  const raw = args['limit']

  if (raw === undefined || raw === '') {
    return clampLimit(pipeline.pageSize, pipeline.maxPageSize)
  }

  return clampLimit(typeof raw === 'string' ? Number(raw) : raw, pipeline.maxPageSize)
}

export const cursorOf = (args: Record<string, unknown>): string | null => {
  const cursor = args['cursor']

  return typeof cursor === 'string' && cursor !== '' ? cursor : null
}

/** Read the `If-Match` header as the optimistic-concurrency version (ETag quotes tolerated). */
export const ifMatchVersion = operation(function* () {
  const request = yield* useRequest()
  const raw = request.meta['if-match']

  if (raw === undefined || raw === '') {
    return undefined
  }

  const version = Number(raw.replaceAll('"', '').trim())

  if (!Number.isInteger(version) || version < 0) {
    return yield* fail(CoreErrors.BadRequest, `invalid If-Match header "${raw}"`)
  }

  return version
})

/** Compile one wizard fn declaration into a core Action (guard wrapped inside the handler). */
export const compileFn = (key: string, fn: WizardFn): Action<AnyType, AnyType> =>
  defineAction(
    {
      input: fn.args,
      output: fn.returns,
      kind: fn.kind,
      route: fn.rest ?? { method: 'POST', path: `/${key}` },
      policies: fn.policies,
      errors: fn.errors,
      docs: fn.docs,
      onDisconnect: fn.onDisconnect,
      outcome: fn.outcome,
    },
    guarded(fn),
  ) as Action<AnyType, AnyType>

export interface AccessInput {
  readonly access?: AccessGuard | undefined
  readonly service: string
  readonly fn: string
  readonly args: unknown
  readonly meta: Meta
}

/**
 * Run an access guard OUTSIDE a broker dispatch (the realtime subscribe path) — synthetic hook
 * contexts are planted so guards can keep using `useRequest`/`useTrace` (`meta` carries the socket
 * handshake headers). `false` fails `server:core.forbidden`, like the compiled wrapper does.
 */
export const runAccess = operation(function* (input: AccessInput) {
  const { access } = input

  if (!access) {
    return
  }

  const allowed = yield* scoped(function* () {
    const trace = yield* rootTrace({ origin: 'external', serviceId: input.service })

    yield* TraceContext.set(trace)
    yield* RequestContext.set({
      cid: trace.actionId,
      service: input.service,
      action: input.fn,
      params: input.args,
      meta: input.meta,
      trace,
    })
    yield* ResponseContext.set({ status: undefined, meta: {} })
    yield* CallContext.set({ service: input.service, action: input.fn, serviceId: input.service })

    return yield* access()
  })

  if (!allowed) {
    return yield* fail(CoreErrors.Forbidden, `access to "${input.service}.${input.fn}" denied`)
  }
})
