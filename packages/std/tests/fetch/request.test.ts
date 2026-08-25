import { attempt, run } from 'std:effect'
import type { FetchDef } from 'std:fetch'
import { Fetch, FetchClient, fetchImpl } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { afterAll, describe, expect, it } from 'bun:test'

import pkg from '../../package.json'

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url)

    if (pathname === '/json') {
      return new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json', 'x-custom': 'merhaba' },
      })
    }

    if (pathname === '/echo') {
      return Response.json({
        method: req.method,
        token: req.headers.get('x-token'),
        body: await req.text(),
      })
    }

    if (pathname === '/method') {
      return new Response(null, { headers: { 'x-method': req.method } })
    }

    if (pathname === '/missing') {
      return new Response('nope', { status: 404, statusText: 'Not Found' })
    }

    if (pathname === '/slow') {
      await Bun.sleep(400)
      return new Response('late')
    }

    return new Response('fallthrough')
  },
})

const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

describe('request dispatch', () => {
  it('GET wraps the platform response and exposes its accessors', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.request(`${base}/json`)

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        type: response.type,
        redirected: response.redirected,
        bodyUsed: response.bodyUsed,
        custom: response.headers.get('x-custom'),
        nativeStatus: response.native.status,
      }
    })

    expect(unwrap(outcome)).toEqual({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: `${base}/json`,
      type: 'default',
      redirected: false,
      bodyUsed: false,
      custom: 'merhaba',
      nativeStatus: 200,
    })
  })

  it('POST delivers method, headers, and body to the server', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.post(`${base}/echo`, {
        headers: { 'x-token': 'secret-42' },
        body: 'payload-body',
      })

      return yield* response.json<{ method: string; token: string; body: string }>()
    })

    expect(unwrap(outcome)).toEqual({
      method: 'POST',
      token: 'secret-42',
      body: 'payload-body',
    })
  })

  it('every method shorthand pins its HTTP verb', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const readMethod = function* (response: FetchDef.Response) {
        const echoed = yield* response.json<{ method: string }>()
        return echoed.method
      }

      // HEAD responses carry no body, so that one is asserted through a response header instead
      const headResponse = yield* Fetch.actions.head(`${base}/method`)

      return {
        get: yield* readMethod(yield* Fetch.actions.get(`${base}/echo`)),
        post: yield* readMethod(yield* Fetch.actions.post(`${base}/echo`)),
        put: yield* readMethod(yield* Fetch.actions.put(`${base}/echo`)),
        patch: yield* readMethod(yield* Fetch.actions.patch(`${base}/echo`)),
        delete: yield* readMethod(yield* Fetch.actions.delete(`${base}/echo`)),
        head: headResponse.headers.get('x-method'),
      }
    })

    expect(unwrap(outcome)).toEqual({
      get: 'GET',
      post: 'POST',
      put: 'PUT',
      patch: 'PATCH',
      delete: 'DELETE',
      head: 'HEAD',
    })
  })

  it('reading the body flips bodyUsed', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.request(`${base}/json`)
      const before = response.bodyUsed
      const text = yield* response.text()

      return { before, text, after: response.bodyUsed }
    })

    expect(unwrap(outcome)).toEqual({ before: false, text: '{"ok":true}', after: true })
  })

  it('the fetchImpl context injects a custom transport', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      return yield* fetchImpl.with(
        () => Promise.resolve(new Response('injected')),
        function* () {
          const response = yield* Fetch.actions.get(`${base}/never-reached`)
          return yield* response.text()
        },
      )
    })

    expect(unwrap(outcome)).toBe('injected')
  })

  it('without an install every request fails with missing-action', async () => {
    const outcome = await run(() => Fetch.actions.get(`${base}/json`))

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('missing-action')
    }
  })
})

describe('expect()', () => {
  it('builder expect() passes a 2xx response straight through to the readers', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/json`)
      const checked = yield* response.expect()

      return yield* checked.json<{ ok: boolean }>()
    })

    expect(unwrap(outcome)).toEqual({ ok: true })
  })

  it('builder expect() turns a non-2xx status into an http-status failure', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const response = yield* Fetch.actions.get(`${base}/missing`)

      return yield* response.expect()
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('http-status')
      expect(outcome.message).toBe(`${base}/missing: 404 Not Found`)
    }
  })

  it('response expect() returns the same wrapped response on ok and fails on non-ok', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      const good = yield* Fetch.actions.get(`${base}/json`)
      const passed = yield* good.expect()

      const bad = yield* Fetch.actions.get(`${base}/missing`)
      const rejected = yield* attempt(() => bad.expect())

      return {
        samePassthrough: passed === good,
        error: isFailure(rejected) ? rejected.error : 'no-failure',
        message: isFailure(rejected) ? rejected.message : '',
      }
    })

    expect(unwrap(outcome)).toEqual({
      samePassthrough: true,
      error: 'http-status',
      message: `${base}/missing: 404 Not Found`,
    })
  })
})

describe('request-level failures', () => {
  it('a refused connection surfaces as a Result failure, not a throw', async () => {
    // grab an ephemeral port, then release it so nothing listens there
    const ghost = Bun.serve({ port: 0, fetch: () => new Response('') })
    let port: number | undefined
    try {
      port = ghost.port
    } finally {
      ghost.stop(true)
    }

    const outcome = await run(function* () {
      yield* install(FetchClient)

      return yield* Fetch.actions.request(`http://127.0.0.1:${port}/`)
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect((outcome.error as { code?: string }).code).toBe('ConnectionRefused')
      // the cause chain names the dispatched action and its plugin tag
      expect(outcome.causes).toContain('request')
      expect(outcome.causes).toContain(`std/fetch@${pkg.version}`)
    }
  })

  it('timeoutMs aborts a hung request with a timeout failure', async () => {
    const outcome = await run(function* () {
      yield* install(FetchClient)

      return yield* Fetch.actions.request(`${base}/slow`, { timeoutMs: 30 })
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('timeout')
      expect(outcome.message).toBe(`${base}/slow: timed out after 30ms`)
    }
  })
})
