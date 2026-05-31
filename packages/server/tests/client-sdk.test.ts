import { describe, expect, it } from 'bun:test'

import { createClient } from '@ozaco/server/client'
import type { ClientDef } from '@ozaco/server/client'
import { defineAction, defineService, Gateway } from '@ozaco/server/core'
import { run } from '@ozaco/std/effect'
import { fetchImpl } from '@ozaco/std/fetch'
import type { FetchImpl } from '@ozaco/std/fetch'
import { isFailure, isSuccess } from '@ozaco/std/result'
import { z } from 'zod'

// Only used for its TYPE (`typeof services`) — the client surface is inferred from it.
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

const manifest: ClientDef.Manifest = {
  web: {
    hello: { method: 'GET', path: '/web/hello/:name' },
    echo: { method: 'POST', path: '/web/echo' },
  },
}

const notFoundFetch: FetchImpl = () =>
  Promise.resolve(Response.json({ error: 'not-found', message: 'no such user' }, { status: 404 }))

const networkFaultFetch: FetchImpl = () => Promise.reject(new Error('boom'))

describe('client runtime — createClient (effect + std:fetch)', () => {
  it('templates path params, returns an Operation, and forwards bodies', async () => {
    const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
    const stubFetch: FetchImpl = (input, init) => {
      calls.push({ input, init })
      return Promise.resolve(
        init?.method === 'GET'
          ? Response.json({ message: 'Hello, Mona!' })
          : Response.json({ echoed: { x: 1 } }),
      )
    }

    const api = createClient<Services>(manifest, { baseUrl: 'https://api.test' })

    const greeting = await run(function* () {
      yield* fetchImpl.set(stubFetch)
      return yield* api.web.hello({ name: 'Mona' })
    })
    expect(String(calls[0]!.input)).toBe('https://api.test/web/hello/Mona')
    expect(calls[0]!.init?.method).toBe('GET')
    expect(isSuccess(greeting)).toBe(true)
    if (isSuccess(greeting)) {
      expect(greeting.value).toEqual({ message: 'Hello, Mona!' })
    }

    const echoed = await run(function* () {
      yield* fetchImpl.set(stubFetch)
      return yield* api.web.echo({ x: 1 })
    })
    expect(calls[1]!.init?.method).toBe('POST')
    expect(calls[1]!.init?.body).toBe('{"x":1}')
    expect(isSuccess(echoed)).toBe(true)
  })

  it('maps non-ok responses to a typed failure', async () => {
    const api = createClient<Services>(manifest, { baseUrl: 'https://api.test' })
    const result = await run(function* () {
      yield* fetchImpl.set(notFoundFetch)
      return yield* api.web.hello({ name: 'ghost' })
    })

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(String(result.error)).toBe('not-found')
      expect(result.message).toBe('no such user')
    }
  })

  it("surfaces a transport fault as std:fetch's typed FetchError", async () => {
    const api = createClient<Services>(manifest, { baseUrl: 'https://api.test' })
    const result = await run(function* () {
      yield* fetchImpl.set(networkFaultFetch)
      return yield* api.web.echo({ x: 1 })
    })

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(String(result.error)).toBe('network')
    }
  })
})
