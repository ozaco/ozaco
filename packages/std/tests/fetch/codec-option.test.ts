import { attempt, run, scoped } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { Fetch, FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { afterAll, describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { fakeCodec } from '../helpers/fake-codec'

const noisy = fakeCodec('NOISY')

const PAYLOAD = { ok: true, n: 7 }

const server = Bun.serve({
  port: 0,
  fetch() {
    return Response.json(PAYLOAD, {
      headers: { 'content-type': 'application/json' },
    })
  },
})

const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

/**
 * Installs the client (with optional install-wide options), JsonCodec, and NOISY at priority
 * 1500 — NOISY outranks JsonCodec, so the ROUTED protocol picks it, and its decode mangles
 * plain JSON. A request only decodes cleanly when something PINS JsonCodec.
 */
function* bootstrap(options?: FetchDef.Options) {
  yield* install(FetchClient, options)
  yield* install(JsonCodec)
  yield* install(noisy, { priority: 1500 })
}

describe('codec option', () => {
  it('a per-request codec pins body() decoding even when routing would pick another', async () => {
    const outcome = await run(function* () {
      yield* bootstrap()

      const pinned = yield* Fetch.actions.get(base, { codec: JsonCodec })
      const routed = yield* Fetch.actions.get(base)

      const routedOutcome = yield* attempt(() => routed.body())

      return {
        pinned: yield* pinned.body<typeof PAYLOAD>(),
        routedFailed: isFailure(routedOutcome) ? 'mangled' : 'decoded',
      }
    })

    expect(unwrap(outcome)).toEqual({ pinned: PAYLOAD, routedFailed: 'mangled' })
  })

  it('a per-request codec pins flow() decoding as well', async () => {
    const outcome = await run(function* () {
      yield* bootstrap()

      const response = yield* Fetch.actions.get(base, { codec: JsonCodec })
      const decoded = yield* response.flow<typeof PAYLOAD>()
      const subscription = yield* decoded

      return (yield* subscription.next()).value
    })

    expect(unwrap(outcome)).toEqual(PAYLOAD)
  })

  it('an install-wide codec applies to every request in the scope', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* bootstrap({ codec: JsonCodec })

        const response = yield* Fetch.actions.get(base)

        return yield* response.body<typeof PAYLOAD>()
      }),
    )

    expect(unwrap(outcome)).toEqual(PAYLOAD)
  })

  it('a per-request codec overrides the install-wide one', async () => {
    const outcome = await run(function* () {
      // install-wide default is the mangling codec; the request pins JsonCodec over it
      yield* bootstrap({ codec: noisy })

      const response = yield* Fetch.actions.get(base, { codec: JsonCodec })

      return yield* response.body<typeof PAYLOAD>()
    })

    expect(unwrap(outcome)).toEqual(PAYLOAD)
  })
})
