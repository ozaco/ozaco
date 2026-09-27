/**
 * Manifest failures are the SERVER's answer: an HTTP failure decodes like an action reply (its own
 * tag, `status:<code>`), a bare 401/403 reads as `client.refused`; only a failed round trip is
 * `client.network`. Codegen's `pull` reads its manifest fetch the same way.
 */
import { pull } from 'client:codegen'
import { ClientErrors, createClient, wireFailureOf } from 'client:core'
import { attempt, run } from 'std:effect'
import { FetchErrors } from 'std:fetch'
import type { Result } from 'std:result'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

const URL_BASE = 'http://manifest.test'

/** A fetch that answers every request with the given reply (or throws it). */
const replying = (reply: () => Response): typeof fetch =>
  (() => {
    try {
      return Promise.resolve(reply())
    } catch (error) {
      return Promise.reject(error)
    }
  }) as unknown as typeof fetch

const manifestFailure = (reply: () => Response) =>
  run(function* () {
    const client = yield* createClient({ url: URL_BASE, fetch: replying(reply) })
    const failed = yield* attempt(client.$manifest())

    return wireFailureOf(failed)
  })

describe('manifest failures', () => {
  it('a bare 401 is client.refused with its status cause and the server body as message', async () => {
    const failure = unwrap(await manifestFailure(() => new Response('no token', { status: 401 })))

    expect(failure.tag).toBe(ClientErrors.Refused)
    expect(failure.status).toBe(401)
    expect(failure.causes).toContain('status:401')
    expect(failure.message).toContain('no token')
    expect(failure.message).toContain('manifest')
  })

  it('a bare 403 is client.refused too', async () => {
    const failure = unwrap(await manifestFailure(() => new Response('', { status: 403 })))

    expect(failure.tag).toBe(ClientErrors.Refused)
    expect(failure.status).toBe(403)
    expect(failure.message).toContain('HTTP 403')
  })

  it('a tagged failure body keeps the server tag, message, causes and request id', async () => {
    const failure = unwrap(
      await manifestFailure(() =>
        Response.json(
          {
            error: { error: 'server.unauthorized', message: 'bad bearer', causes: ['auth.jwt'] },
          },
          { status: 401, headers: { 'x-request-id': 'r-1' } },
        ),
      ),
    )

    expect(failure.tag).toBe('server.unauthorized')
    expect(failure.message).toContain('bad bearer')
    // the server's causes, where it came from, then the client's breadcrumbs LAST
    expect(failure.causes).toEqual(['auth.jwt', 'remote: manifest', 'req:r-1', 'status:401'])
    expect(failure.status).toBe(401)
    expect(failure.requestId).toBe('r-1')
  })

  it('an `oz-error` header tags a bodyless failure', async () => {
    const failure = unwrap(
      await manifestFailure(
        () => new Response(null, { status: 403, headers: { 'oz-error': 'server.forbidden' } }),
      ),
    )

    expect(failure.tag).toBe('server.forbidden')
    expect(failure.status).toBe(403)
  })

  it('a 500 is http.500 (not client.network) with its status cause', async () => {
    const failure = unwrap(await manifestFailure(() => new Response('kaput', { status: 500 })))

    expect(failure.tag).toBe('http.500')
    expect(failure.status).toBe(500)
    expect(failure.message).toContain('kaput')
  })

  it('a connection error stays client.network', async () => {
    const failure = unwrap(
      await manifestFailure(() => {
        throw new TypeError('connection refused')
      }),
    )

    expect(failure.tag).toBe(ClientErrors.Network)
    expect(failure.status).toBeNull()
    // the platform text, never `until`'s `std:result.unknown` fold of the rejection; the manifest
    // fetch is named in the causes
    expect(failure.message).toBe('connection refused')
    expect(failure.causes).toEqual(['std:effect.until', 'manifest'])
  })

  it('the platform error is the failure`s raw; its code names the failure', async () => {
    // the platform's verdict is its code (Bun's refused connection even has an EMPTY message)
    const refused = Object.assign(new TypeError('fetch failed'), { code: 'ConnectionRefused' })

    const { failed } = unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: URL_BASE,
          fetch: replying(() => {
            throw refused
          }),
        })

        // boxed: a Failure the run returns would fail the run itself
        return { failed: (yield* attempt(client.$manifest())) as Result.Failure<unknown> }
      }),
    )

    expect(isFailure(failed)).toBe(true)
    expect(failed.error).toBe(ClientErrors.Network)
    expect(failed.message).toBe('ConnectionRefused')
    // ONE level: the platform error itself is its `raw` (no nested fold)
    expect(failed.raw).toBe(refused)
    expect(failed.causes).toEqual(['std:effect.until', 'manifest'])
  })

  it('a custom fetch`s failure (std:fetch.network) is nested under client.network', async () => {
    const offline = fail(FetchErrors.Network, 'ConnectionRefused')

    const { failed } = unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: URL_BASE,
          fetch: (() => Promise.reject(offline)) as unknown as typeof fetch,
        })

        return { failed: (yield* attempt(client.$manifest())) as Result.Failure<unknown> }
      }),
    )

    expect(failed.error).toBe(ClientErrors.Network)
    expect(failed.message).toBe('manifest')
    // the custom fetch's own failure, one level down as the SAME object
    expect(failed.causes).toHaveLength(1)
    expect(failed.causes[0]).toBe(offline)
  })

  it('a failed manifest is not cached: the next call fetches again', async () => {
    let calls = 0

    const tag = unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: URL_BASE,
          fetch: replying(() => {
            calls += 1
            return new Response('', { status: 401 })
          }),
        })

        yield* attempt(client.$manifest())
        return ((yield* attempt(client.$manifest())) as AnyType).error as string
      }),
    )

    expect(tag).toBe(ClientErrors.Refused)
    expect(calls).toBe(2)
  })
})

/** `op` with the GLOBAL fetch answering every request with the reply (or throwing it): `pull`
 * has no `fetch` option, and a client without one reads the global at call time too. */
const withGlobalFetch = async <T>(reply: () => Response, op: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = replying(reply)

  try {
    return await op()
  } finally {
    globalThis.fetch = original
  }
}

/** The runtime client's `$manifest()` failure and codegen `pull`'s, for the same reply. */
const bothFailures = async (reply: () => Response) =>
  unwrap(
    await withGlobalFetch(reply, () =>
      run(function* () {
        const client = yield* createClient({ url: URL_BASE })
        const runtime = (yield* attempt(client.$manifest())) as Result.Failure<unknown>
        const pulled = (yield* attempt(pull(URL_BASE))) as Result.Failure<unknown>

        // boxed: a Failure the run returns would fail the run itself
        return { runtime, pulled }
      }),
    ),
  )

describe('codegen pull fails like the runtime manifest fetch', () => {
  it('a failed round trip is client.network, the platform error its raw', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { code: 'ConnectionRefused' })
    const { runtime, pulled } = await bothFailures(() => {
      throw refused
    })

    expect(isFailure(pulled)).toBe(true)
    expect(pulled.error).toBe(ClientErrors.Network)
    // the platform code, never `until`'s `std:result.unknown` fold of the rejection
    expect(pulled.message).toBe('ConnectionRefused')
    // ONE level: the platform error itself is its `raw` (no nested fold)
    expect(pulled.raw).toBe(refused)
    expect(pulled.causes).toEqual(['std:effect.until', 'manifest'])

    expect(runtime.error).toBe(pulled.error)
    expect(runtime.message).toBe(pulled.message)
    expect(runtime.causes).toEqual(pulled.causes)
    expect(runtime.raw).toBe(refused)
  })

  it('a platform error without a code is named by its message, the same on both sides', async () => {
    const { runtime, pulled } = await bothFailures(() => {
      throw new TypeError('connection refused')
    })

    expect(wireFailureOf(pulled)).toEqual({
      tag: ClientErrors.Network,
      message: 'connection refused',
      causes: ['std:effect.until', 'manifest'],
      status: null,
      requestId: null,
    })
    expect(wireFailureOf(runtime)).toEqual(wireFailureOf(pulled))
  })

  it('an HTTP failure stays the server answer (never client.network), the same on both sides', async () => {
    const { runtime, pulled } = await bothFailures(() => new Response('kaput', { status: 500 }))

    expect(wireFailureOf(pulled).tag).toBe('http.500')
    expect(wireFailureOf(pulled).status).toBe(500)
    expect(wireFailureOf(runtime)).toEqual(wireFailureOf(pulled))
  })

  it('an unreachable server fails client.network with the platform text', async () => {
    const pulled = unwrap(
      await run(function* () {
        return { failed: (yield* attempt(pull('http://127.0.0.1:1'))) as Result.Failure<unknown> }
      }),
    ).failed

    expect(pulled.error).toBe(ClientErrors.Network)
    expect(pulled.message.length).toBeGreaterThan(0)
    expect(pulled.message).not.toContain('std:result.unknown')
    expect(pulled.causes).toEqual(['std:effect.until', 'manifest'])
    expect(pulled.raw).toBeInstanceOf(Error)
  })
})
