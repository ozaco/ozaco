/**
 * `dispatchSpan()` (`@ozaco/server/internal`): a server plugin's handle on the dispatch span
 * `{service}.{action}` — dispatch-level attributes / links / events land THERE even while a span
 * of another plugin (a cache span wrapping the dispatch) is the active one; the no-op handle
 * outside a dispatch and under suppression. `dispatchFailure` classifies a wrapping span's
 * failure like the dispatch it wraps.
 */
import type { ServerDef } from 'server:core'
import { action, createServer, Server, service } from 'server:core'
import { dispatchFailure, dispatchSpan, scopeOf } from 'server:internal'
import { attempt, run } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { current, span, suppressed } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { storage } from '../helpers'

const shop = service('shop', {
  buy: action.mutation({}, function* () {
    return 'bought'
  }),
  refuse: action.mutation({ errors: { 'shop.refused': 409 } }, function* () {
    return yield* fail('shop.refused', 'not today')
  }),
})

/** An observe hook collecting every span the kernel reports. */
const spy = () => {
  const spans: TraceDef.SpanData[] = []

  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'test/dispatch-span-spy',
    version: '0',
    description: 'captures spans',
    *setup() {
      const hooks: ServerDef.Hooks = {
        name: 'spy',
        *observe(event) {
          if (event.t === 'span') {
            spans.push(event.span)
          }
        },
      }
      return { hooks }
    },
  }).build()

  const one = (name: string): TraceDef.SpanData => {
    const found = spans.filter(data => data.name === name)
    expect(found).toHaveLength(1)
    return found[0]!
  }

  return { plugin, spans, one }
}

/** Wraps every dispatch in a span of its own (what the Cache plugin does), classified like the
 * dispatch it wraps. */
const Wrapping = definePlugin<ServerDef.PluginContext, []>({
  name: 'test/wrapping',
  version: '0',
  description: 'a cache-like span around the dispatch',
  *setup() {
    const hooks: ServerDef.Hooks = {
      name: 'wrapping',
      *dispatch(call, ctx, next) {
        return yield* span(
          `cache ${call.service}.${call.action}`,
          { scope: scopeOf('cache'), failure: dispatchFailure(call, ctx.meta) },
          () => next(call, ctx),
        )
      },
    }
    return { hooks }
  },
}).build()

/** What the handles look like from INSIDE the wrapping span. */
const seenFrom: { active: string[]; dispatch: string[]; muted: boolean[] } = {
  active: [],
  dispatch: [],
  muted: [],
}

/** Writes a dispatch-level attribute (what resilience / crud / auth do). */
const Writing = definePlugin<ServerDef.PluginContext, []>({
  name: 'test/writing',
  version: '0',
  description: 'writes a dispatch-level attribute',
  *setup() {
    const hooks: ServerDef.Hooks = {
      name: 'writing',
      *dispatch(call, ctx, next) {
        const handle = yield* dispatchSpan()
        handle.setAttribute('ozaco.test.dispatch_level', true)
        seenFrom.dispatch.push(handle.context.spanId)
        seenFrom.active.push((yield* current()).context.spanId)
        // suppressed code gets the no-op handle, even inside a dispatch
        seenFrom.muted.push((yield* suppressed(() => dispatchSpan())).recording)

        return yield* next(call, ctx)
      },
    }
    return { hooks }
  },
}).build()

describe('dispatchSpan()', () => {
  it('a plugin writes on the DISPATCH span while a wrapping cache span is the active one', async () => {
    const seen = spy()
    let outside: TraceDef.SpanHandle | null = null
    let inSpan: TraceDef.SpanHandle | null = null

    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [shop],
          plugins: [seen.plugin.use(), Wrapping.use(), Writing.use()],
        })
        yield* server.start()
        yield* server.call(shop, 'buy', {})
        yield* attempt(server.call(shop, 'refuse', {}))
        outside = yield* dispatchSpan()
        yield* Server.actions.span('outside', function* () {
          inSpan = yield* dispatchSpan()
        })
        yield* server.stop()
      }),
    )

    const dispatch = seen.one('shop.buy')
    const cache = seen.one('cache shop.buy')

    // the cache span wraps the dispatch — and is what `current()` hands the plugin
    expect(cache.parent?.spanId).toBe(dispatch.context.spanId)
    expect(seenFrom.active[0]).toBe(cache.context.spanId)
    expect(seenFrom.dispatch[0]).toBe(dispatch.context.spanId)

    // the dispatch-level attribute landed on the dispatch span, not on the cache span
    expect(dispatch.attributes['ozaco.test.dispatch_level']).toBe(true)
    expect(cache.attributes['ozaco.test.dispatch_level']).toBeUndefined()
    expect(seenFrom.muted.every(recording => recording === false)).toBe(true)

    // outside any dispatch — even inside another span — the no-op handle
    expect(outside!.recording).toBe(false)
    expect(inSpan!.recording).toBe(false)
    expect(inSpan!.context.spanId).toBe(outside!.context.spanId)
    expect(inSpan!.context.spanId).not.toBe(seen.one('outside').context.spanId)

    // the wrapping span classifies the refusal like the dispatch: a mapped 409 leaves both unset
    const refusedCache = seen.one('cache shop.refuse')
    const refusedDispatch = seen.one('shop.refuse')
    for (const data of [refusedCache, refusedDispatch]) {
      expect(data.status.code).toBe('unset')
      expect(data.attributes['error.type']).toBe('shop.refused')
    }
    expect(refusedDispatch.attributes['ozaco.test.dispatch_level']).toBe(true)
    expect(refusedCache.attributes['ozaco.test.dispatch_level']).toBeUndefined()
  })

  it('`dispatchFailure` classifies a wrapping span like the dispatch (the errors map, the exception name)', () => {
    const local = dispatchFailure({ transport: 'edge' }, { errors: { 'shop.refused': 409 } })
    const carried = dispatchFailure({ transport: 'memory' }, null)
    // a Failure value, never raised
    const refused = fail('shop.refused', 'not today')

    expect(local.eventName).toBe('ozaco.action.exception')
    expect(carried.eventName).toBe('rpc.server.call.exception')
    expect(local.status?.(refused)).toBe(409)
    expect(carried.status?.(refused)).toBe(500)
    expect(local.type?.(refused)).toBe('shop.refused')
  })
})
