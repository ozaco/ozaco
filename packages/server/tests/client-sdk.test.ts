import { describe, expect, it } from 'bun:test'

import { connect } from '@ozaco/server/client'
import type { ClientDef } from '@ozaco/server/client'
import { defineAction, defineService, Gateway } from '@ozaco/server/core'
import { RetryPolicy } from '@ozaco/server/policy/retry'
import { run } from '@ozaco/std/effect'
import { fetchImpl } from '@ozaco/std/fetch'
import type { FetchImpl } from '@ozaco/std/fetch'
import { WebIO } from '@ozaco/std/io/impl/web'
import { install } from '@ozaco/std/plugin'
import { isFailure, isSuccess } from '@ozaco/std/result'
import { z } from 'zod'

// The backend `services` — used only for its TYPE; the client surface is inferred from it.
const web = defineService({
  name: 'web',
  version: '0.0.0',
  actions: {
    hello: defineAction(
      {
        settings: [Gateway.actions.rest({ method: 'GET', path: '/hello/:name' })],
        input: z.object({ name: z.string() }),
      },
      function* (body) {
        return { message: `Hello, ${body.name}!` }
      },
    ),
    echo: defineAction(
      { settings: [Gateway.actions.rest({ method: 'POST', path: '/echo' })] },
      function* (body?: unknown) {
        return { echoed: body }
      },
    ),
  },

  *setup() {},
})

const services = { web }
type Services = typeof services

const manifest = {
  web: {
    hello: { method: 'GET', path: '/web/hello/:name' },
    echo: { method: 'POST', path: '/web/echo' },
  },
} satisfies ClientDef.Manifest

const notFound: FetchImpl = () =>
  Promise.resolve(Response.json({ error: 'not-found', message: 'no such page' }, { status: 404 }))

describe('client broker — defineClient (broker + policy + codec, std:fetch core, no transport)', () => {
  it('dispatches a GET through the broker, templating path params', async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const stubFetch: FetchImpl = (input, init) => {
      calls.push({ input, init })
      return Promise.resolve(Response.json({ message: 'Hello, Mona!' }))
    }

    const outcome = await run(function* () {
      yield* install(WebIO)
      yield* fetchImpl.set(stubFetch)
      const api = yield* connect<Services>({ baseUrl: 'https://api.test', manifest })
      return yield* api.web.actions.hello({ name: 'Mona' })
    })

    expect(String(calls[0]!.input)).toBe('https://api.test/web/hello/Mona')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value).toEqual({ message: 'Hello, Mona!' })
    }
  })

  it('encodes a POST body via the codec', async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const stubFetch: FetchImpl = (input, init) => {
      calls.push({ input, init })
      return Promise.resolve(Response.json({ echoed: { x: 1 } }))
    }

    const outcome = await run(function* () {
      yield* install(WebIO)
      yield* fetchImpl.set(stubFetch)
      const api = yield* connect<Services>({ baseUrl: 'https://api.test', manifest })
      return yield* api.web.actions.echo({ x: 1 })
    })

    expect(String(calls[0]!.input)).toBe('https://api.test/web/echo')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value).toEqual({ echoed: { x: 1 } })
    }
  })

  it('surfaces a non-2xx response as a failure', async () => {
    const outcome = await run(function* () {
      yield* install(WebIO)
      yield* fetchImpl.set(notFound)
      const api = yield* connect<Services>({ baseUrl: 'https://api.test', manifest })
      return yield* api.web.actions.hello({ name: 'ghost' })
    })

    expect(isFailure(outcome)).toBe(true)
  })

  it('wraps the std:fetch core in the policy onion (RetryPolicy retries a transient failure)', async () => {
    let attempt = 0
    const flaky: FetchImpl = () => {
      attempt += 1
      return Promise.resolve(
        attempt < 2
          ? Response.json({ error: 'upstream', message: 'try again' }, { status: 503 })
          : Response.json({ message: 'Hello, Mona!' }),
      )
    }

    const outcome = await run(function* () {
      yield* install(WebIO)
      yield* fetchImpl.set(flaky)
      const api = yield* connect<Services>({ baseUrl: 'https://api.test', manifest })
      yield* install(RetryPolicy, { attempts: 3 })
      return yield* api.web.actions.hello({ name: 'Mona' })
    })

    expect(attempt).toBe(2)
    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value).toEqual({ message: 'Hello, Mona!' })
    }
  })
})
