import { attempt, run } from 'std:effect'
import { Fetch, FetchClient, FetchErrors, fetchImpl } from 'std:fetch'
import { isFailure, unwrap } from 'std:result'

import { afterAll, describe, expect, it } from 'bun:test'

// `retry` re-sends on what `on` names with backoff; `maxBytes` caps a body read; `proxy` rides
// through to the platform.

const hits: Record<string, number> = {}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url)

    hits[pathname] = (hits[pathname] ?? 0) + 1

    if (pathname === '/flaky') {
      return hits[pathname]! < 3
        ? new Response('not yet', { status: 503 })
        : new Response('finally')
    }

    if (pathname === '/always') {
      return new Response('down', { status: 500 })
    }

    if (pathname === '/big') {
      return new Response('x'.repeat(100))
    }

    return new Response('ok')
  },
})

const base = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

describe('fetch — retry + maxBytes', () => {
  it('re-sends a 5xx as the policy says, answers the last one when the attempts run out, leaves it alone without a policy', async () => {
    const outcome = unwrap(
      await run(function* () {
        yield* FetchClient.use()

        const recovered = yield* Fetch.actions.get(`${base}/flaky`, {
          retry: { attempts: 3, delayMs: 1 },
        })
        const exhausted = yield* Fetch.actions.get(`${base}/always`, {
          retry: { attempts: 2, delayMs: 1 },
        })
        const plain = yield* Fetch.actions.get(`${base}/always`)

        return {
          recovered: [recovered.status, yield* recovered.text()],
          exhausted: exhausted.status,
          plain: plain.status,
        }
      }),
    )

    expect(outcome).toEqual({ recovered: [200, 'finally'], exhausted: 500, plain: 500 })
    expect(hits['/flaky']).toBe(3)
    expect(hits['/always']).toBe(3)
  })

  it('re-sends a network fault, not a timeout unless asked; the install default applies', async () => {
    let calls = 0
    const stub = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1

      return calls < 3 ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init)
    }) as typeof fetch

    const outcome = unwrap(
      await run(function* () {
        yield* FetchClient.use({ retry: { attempts: 3, delayMs: 1 } })

        return yield* fetchImpl.with(stub, function* () {
          const response = yield* Fetch.actions.get(`${base}/plain`)
          const text = yield* response.text()

          calls = 0

          const refused = yield* attempt(() =>
            Fetch.actions.get(`${base}/plain`, { retry: { attempts: 2, on: ['5xx'], delayMs: 1 } }),
          )

          return { text, refused: isFailure(refused) ? refused.error : null, calls }
        })
      }),
    )

    expect(outcome).toEqual({ text: 'ok', refused: FetchErrors.Network, calls: 1 })
  })

  it('maxBytes: the body read fails std:fetch.too-large past the cap', async () => {
    const outcome = unwrap(
      await run(function* () {
        yield* FetchClient.use()

        const capped = yield* Fetch.actions.get(`${base}/big`, { maxBytes: 10 })
        const read = yield* attempt(() => capped.text())
        const fine = yield* Fetch.actions.get(`${base}/big`, { maxBytes: 1000 })

        return {
          status: capped.status,
          read: isFailure(read) ? read.error : 'read',
          fine: (yield* fine.text()).length,
        }
      }),
    )

    expect(outcome).toEqual({ status: 200, read: FetchErrors.TooLarge, fine: 100 })
  })
})
