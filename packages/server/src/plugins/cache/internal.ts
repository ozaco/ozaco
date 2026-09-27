// oxlint-disable import/exports-last
import type { KvDef } from 'db:core'
import { Kv } from 'db:core'
import { dispatchFailure, dispatchSpan, scopeOf } from 'server:internal'
import type { Operation } from 'std:effect'
import { attempt } from 'std:effect'
import { Logger, LogLevel } from 'std:logger'
import type { Result } from 'std:result'
import { formatFailure, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'
import {
  canEmit,
  current,
  emitLog,
  extract,
  parseTraceparent,
  recordFailure,
  span,
  traceparentOf,
} from 'std:trace'

import { logAttributes, severityOf } from 'std:logger/transport/trace'
import { z } from 'zod'

import type { CacheDef } from './types'

/** The instrumentation scope of every cache record (`@ozaco/server/cache`). */
export const CACHE_SCOPE = scopeOf('cache')

/** The span event a mutation's `invalidate` leaves on the writer's span (≤ 20 chars). */
const EVICT_EVENT = 'ozaco.cache.evict'

/** The action options this plugin owns (validated by the kernel at createServer). */
export const options = {
  cache: z.object({
    ttlMs: z.number().positive(),
    vary: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }),

  /** tags a (mutating) action drops once it succeeds. */
  invalidate: z.array(z.string()).min(1),
}

export const pick = (root: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((at, key) => (at as AnyType)?.[key], root)

export const hash = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined'
  let code = 0

  for (let index = 0; index < text.length; index += 1) {
    code = (code * 31 + (text.codePointAt(index) ?? 0)) | 0
  }

  return (code >>> 0).toString(36)
}

export const keyOf = ({ prefix, call, ctx, cache }: CacheDef.KeyInput): string => {
  const root = { input: call.input, auth: ctx.auth, headers: call.headers } as Record<
    string,
    unknown
  >
  const material = cache.vary ? cache.vary.map(path => pick(root, path)) : call.input

  return `${prefix}:${call.service}.${call.action}:${hash(material)}`
}

// --- entries ----------------------------------------------------------------------------------

/** Whether a stored value is a cache envelope (`{ $oz: 1, v, tp? }`) rather than a legacy value. */
export const isEntry = (value: unknown): value is CacheDef.Entry =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (value as { $oz?: unknown }).$oz === 1

/** The envelope a miss stores: the answer and — when the computing span records — its context. */
export const entryOf = (value: unknown, producer: TraceDef.SpanHandle): CacheDef.Entry =>
  producer.recording
    ? { $oz: 1, v: value, tp: traceparentOf(producer.context) }
    : { $oz: 1, v: value }

// --- logging ----------------------------------------------------------------------------------

/**
 * A failure the cache swallowed (an invalidation, a change feed): recorded — once, WARN, on `at`
 * (the writer's dispatch span after a mutation) else the active span (its exception event +
 * record) — whatever a Logger's level lets through, and told as a WARN line correlated to the
 * active span: through the installed std `Logger` (binding `logger: '@ozaco/server/cache'`; its
 * `TraceTransport` bridges the line), else straight to the sinks with the same shape. Never fails
 * the caller.
 *
 * The line goes FIRST when it lands on the span the failure belongs to: the Logger prints the
 * failure once (the line — the server never forwards the record of a failure a line printed) and
 * its bridge records it there; the explicit record after it is then a no-op, kept for a Logger
 * that drops the line (its level) or has no bridge. Only when `at` is not the active span is the
 * record made first (on `at`).
 */
export function* cacheWarn(
  msg: string,
  failure: Result.Failure<unknown>,
  {
    fields,
    at,
  }: {
    readonly fields: Readonly<Record<string, unknown>>
    readonly at?: TraceDef.SpanHandle | undefined
  },
): Operation<void> {
  yield* attempt(function* () {
    const severity = severityOf(LogLevel.warn)
    const record = () =>
      at
        ? at.recordFailure(failure, { severity: severity.number })
        : recordFailure(failure, { severity: severity.number })

    if (at && at.context.spanId !== (yield* current()).context.spanId) {
      yield* record()
    }

    if ((yield* Logger.context.get()) !== undefined) {
      yield* Logger.actions.child({ logger: CACHE_SCOPE.name }, () =>
        Logger.actions.warn(msg, { ...fields, error: failure }),
      )
      yield* record()
      return
    }

    yield* record()

    if (!(yield* canEmit())) {
      return
    }

    yield* emitLog({
      body: msg || formatFailure(failure),
      severityNumber: severity.number,
      severityText: severity.text,
      attributes: logAttributes(fields),
      scope: CACHE_SCOPE,
    })
  })
}

// --- lookup -----------------------------------------------------------------------------------

/**
 * One cached dispatch in its span `cache {service}.{action}` — ALWAYS internal (scope
 * `@ozaco/server/cache`): `ozaco.cache.key` / `.store` / `.ttl_ms`, and `ozaco.cache.hit` /
 * `.coalesced` as soon as the store says where the answer comes from (`Kv.wrap`'s `onSource` — no
 * racy pre-check). A miss runs the rest of the chain (the handler) UNDER this span and stores the
 * answer with this span's context; a hit or a coalesced wait LINKS the span that computed it
 * (`ozaco.link.reason = 'cache.producer'`). A legacy plain value is a hit without a link.
 */
export function* lookup(input: CacheDef.LookupInput): Operation<unknown> {
  const { call, ctx, cache, next } = input
  const key = keyOf(input)
  const store = (yield* Kv.context.get())?.store

  return yield* span(
    `cache ${call.service}.${call.action}`,
    {
      kind: 'internal',
      scope: CACHE_SCOPE,
      attributes: {
        'ozaco.cache.key': key,
        'ozaco.cache.store': store,
        'ozaco.cache.ttl_ms': cache.ttlMs,
      },
      failure: dispatchFailure(call, ctx.meta),
    },
    function* (handle) {
      // told synchronously by `wrap` (the cast keeps the callback's assignment visible to TS)
      let source = 'miss' as KvDef.Source

      const stored = yield* Kv.actions.wrap<unknown>(
        key,
        {
          ttlMs: cache.ttlMs,
          tags: cache.tags,
          onSource(given) {
            source = given
            handle.setAttributes({
              'ozaco.cache.hit': given === 'hit',
              'ozaco.cache.coalesced': given === 'coalesced',
            })
          },
        },
        function* () {
          return entryOf(yield* next(call, ctx), handle)
        },
      )

      if (!isEntry(stored)) {
        return stored
      }

      const producer = source === 'miss' || !stored.tp ? null : parseTraceparent(stored.tp)

      if (producer) {
        handle.addLink(producer, { 'ozaco.link.reason': 'cache.producer' })
      }

      return stored.v
    },
  )
}

// --- invalidation -----------------------------------------------------------------------------

/**
 * A mutation's `invalidate` once it succeeded: the tags dropped and an `ozaco.cache.evict`
 * `{ ozaco.cache.tags }` span event on the writer's span — the mutation's DISPATCH span
 * (`dispatchSpan()`), whatever plugin span is active around this hook. A failed invalidation
 * never fails the committed mutation — it is logged (WARN, the failure recorded once, on that
 * same span).
 */
export function* evict(tags: readonly string[]): Operation<void> {
  const writer = yield* dispatchSpan()
  const dropped = yield* attempt(() => Kv.actions.invalidate(...tags))

  if (isFailure(dropped)) {
    yield* cacheWarn('cache invalidation failed after the mutation', dropped, {
      fields: { 'ozaco.cache.tags': [...tags] },
      at: writer,
    })
    return
  }

  writer.addEvent(EVICT_EVENT, { 'ozaco.cache.tags': [...tags] })
}

/**
 * One change of a tagged table: the table's tag dropped in a `record: 'errors'` ROOT span
 * `cache.invalidate {table}` (exported only when it fails) that LINKS the write behind the change
 * (`ozaco.link.reason = 'change.writer'` — the writer's `traceparent` rides the change's bus
 * meta). A failure is logged (WARN, correlated to that span) and fails the span; the feed goes on.
 */
export function* invalidateOn(table: string, change: CacheDef.FeedEvent): Operation<void> {
  const writer = extract(name => change.meta?.[name] ?? null)
  const store = (yield* Kv.context.get())?.store

  yield* attempt(() =>
    span(
      `cache.invalidate ${table}`,
      {
        kind: 'internal',
        scope: CACHE_SCOPE,
        parent: null,
        record: 'errors',
        attributes: { 'ozaco.cache.tags': [table], 'ozaco.cache.store': store },
        links: writer
          ? [{ context: writer, attributes: { 'ozaco.link.reason': 'change.writer' } }]
          : [],
      },
      function* () {
        const dropped = yield* attempt(() => Kv.actions.invalidate(table))

        if (isFailure(dropped)) {
          yield* cacheWarn(`cache invalidation of ${table} failed`, dropped, {
            fields: { 'ozaco.cache.tags': [table] },
          })
        }

        // a returned failure fails the span (kept by `record: 'errors'`) without raising
        return isFailure(dropped) ? dropped : undefined
      },
    ),
  )
}

/**
 * Follow one table's change feed for as long as the node runs, invalidating its tag on every
 * change. A feed that cannot be opened is logged (WARN) — the cache then only drops that table's
 * entries through TTLs and explicit `invalidate`.
 */
export function* follow(open: () => Operation<CacheDef.Feed>, table: string): Operation<void> {
  const feed = yield* attempt(open)

  if (isFailure(feed)) {
    yield* cacheWarn(`cache cannot follow the ${table} change feed`, feed, {
      fields: { 'ozaco.cache.tags': [table] },
    })
    return
  }

  for (;;) {
    const step = yield* feed.value.next()

    if (step.done) {
      return
    }

    yield* invalidateOn(table, step.value)
  }
}
