import { run, scoped } from 'std:effect'
import { createFetchResponse, Fetch, FetchClient } from 'std:fetch'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { afterAll, describe, expect, it } from 'bun:test'

let hits = 0

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url)

    if (pathname === '/where') {
      return Response.json({ server: 'a', path: pathname })
    }

    if (pathname === '/headers') {
      return Response.json({
        app: req.headers.get('x-app'),
        token: req.headers.get('x-token'),
      })
    }

    if (pathname === '/auth-echo') {
      return Response.json({
        authorization: req.headers.get('authorization'),
        req: req.headers.get('x-req'),
      })
    }

    if (pathname === '/hit' || pathname === '/cached') {
      hits += 1
      return new Response('served')
    }

    if (pathname === '/slow') {
      await Bun.sleep(400)
      return new Response('late')
    }

    return new Response('fallthrough')
  },
})

const other = Bun.serve({
  port: 0,
  fetch(req) {
    return Response.json({ server: 'b', path: new URL(req.url).pathname })
  },
})

const base = `http://127.0.0.1:${server.port}`
const otherBase = `http://127.0.0.1:${other.port}`

afterAll(() => {
  server.stop(true)
  other.stop(true)
})

describe('install options', () => {
  it('baseUrl resolves relative string inputs; absolute URLs and Requests pass through', async () => {
    interface Where {
      server: string
      path: string
    }

    const outcome = await run(function* () {
      yield* install(FetchClient, { baseUrl: base })

      const relative = yield* Fetch.actions.get('/where')
      const absoluteString = yield* Fetch.actions.get(`${otherBase}/where`)
      const urlObject = yield* Fetch.actions.get(new URL(`${otherBase}/where`))
      const requestObject = yield* Fetch.actions.request(new Request(`${otherBase}/where`))

      return {
        relative: yield* relative.json<Where>(),
        absoluteString: yield* absoluteString.json<Where>(),
        urlObject: yield* urlObject.json<Where>(),
        requestObject: yield* requestObject.json<Where>(),
      }
    })

    expect(unwrap(outcome)).toEqual({
      relative: { server: 'a', path: '/where' },
      absoluteString: { server: 'b', path: '/where' },
      urlObject: { server: 'b', path: '/where' },
      requestObject: { server: 'b', path: '/where' },
    })
  })

  it('default headers apply and merge UNDER the per-request ones', async () => {
    interface Seen {
      app: string | null
      token: string | null
    }

    const outcome = await run(function* () {
      yield* install(FetchClient, {
        baseUrl: base,
        headers: { 'x-app': 'ozaco', 'x-token': 'default-token' },
      })

      const defaultsOnly = yield* Fetch.actions.get('/headers')
      const initWins = yield* Fetch.actions.get('/headers', {
        headers: { 'x-token': 'override' },
      })
      const requestWins = yield* Fetch.actions.request(
        new Request(`${base}/headers`, { headers: { 'x-token': 'from-request' } }),
      )

      return {
        defaultsOnly: yield* defaultsOnly.json<Seen>(),
        initWins: yield* initWins.json<Seen>(),
        requestWins: yield* requestWins.json<Seen>(),
      }
    })

    expect(unwrap(outcome)).toEqual({
      defaultsOnly: { app: 'ozaco', token: 'default-token' },
      initWins: { app: 'ozaco', token: 'override' },
      requestWins: { app: 'ozaco', token: 'from-request' },
    })
  })

  it('timeoutMs option is the default deadline; a per-request timeoutMs overrides it', async () => {
    const timedOut = await run(function* () {
      yield* install(FetchClient, { baseUrl: base, timeoutMs: 25 })

      return yield* Fetch.actions.get('/slow')
    })

    expect(isFailure(timedOut)).toBe(true)
    if (isFailure(timedOut)) {
      expect(timedOut.error).toBe('timeout')
      expect(timedOut.message).toBe(`${base}/slow: timed out after 25ms`)
    }

    const overridden = await run(function* () {
      yield* install(FetchClient, { baseUrl: base, timeoutMs: 25 })

      const response = yield* Fetch.actions.get('/slow', { timeoutMs: 2000 })

      return yield* response.text()
    })

    expect(unwrap(overridden)).toBe('late')
  })
})

describe('middleware over the request dispatch', () => {
  it('an around hook injecting a header reaches builder accessor calls, then reverts with its scope', async () => {
    interface Auth {
      authorization: string | null
      req: string | null
    }

    const outcome = await run(function* () {
      yield* install(FetchClient, { baseUrl: base })

      const decorated = yield* scoped(function* () {
        yield* Fetch.around({
          request: ([input, init], next) =>
            (function* () {
              return yield* next(input, {
                ...init,
                headers: {
                  ...(init?.headers as Record<string, string> | undefined),
                  authorization: 'Bearer sekret-7',
                },
              })
            })(),
        })

        const response = yield* Fetch.actions.get('/auth-echo', { headers: { 'x-req': 'kept' } })

        return yield* response.json<Auth>()
      })

      const plainResponse = yield* Fetch.actions.get('/auth-echo')
      const plain = yield* plainResponse.json<Auth>()

      return { decorated, plainAuthorization: plain.authorization }
    })

    expect(unwrap(outcome)).toEqual({
      decorated: { authorization: 'Bearer sekret-7', req: 'kept' },
      plainAuthorization: null,
    })
  })

  it('middleware can observe every dispatch and short-circuit with a synthetic response', async () => {
    const before = hits
    const trace: string[] = []
    const observedUrls: string[] = []

    const outcome = await run(function* () {
      yield* install(FetchClient, { baseUrl: base })

      // installed FIRST so it wraps the around layer below and observes short-circuits too
      yield* Fetch.after({
        *request(result) {
          observedUrls.push(result.url)
        },
      })
      yield* Fetch.around({
        request: ([input, init], next) =>
          (function* () {
            trace.push(String(input))
            if (String(input) === '/cached') {
              return createFetchResponse(new Response('from-cache'))
            }
            return yield* next(input, init)
          })(),
      })

      const network = yield* Fetch.actions.get('/hit')
      const cached = yield* Fetch.actions.get('/cached')

      return {
        network: yield* network.text(),
        cached: yield* cached.text(),
      }
    })

    expect(unwrap(outcome)).toEqual({ network: 'served', cached: 'from-cache' })
    // the short-circuited dispatch never reached the server
    expect(hits - before).toBe(1)
    // hooks see the PRE-resolution input, before baseUrl is applied
    expect(trace).toEqual(['/hit', '/cached'])
    // a synthetic Response carries no url, the network one keeps its resolved target
    expect(observedUrls).toEqual([`${base}/hit`, ''])
  })
})
