/**
 * Manifest failures are the SERVER's answer: an HTTP failure decodes like an action reply (its own
 * tag, `status:<code>`), a bare 401/403 reads as `client.refused`; only a failed round trip is
 * `client.network`.
 */
import { ClientErrors, createClient, wireFailureOf } from 'client:core'
import { attempt, run } from 'std:effect'
import { unwrap } from 'std:result'
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
    expect(failure.causes).toEqual(['auth.jwt', 'req:r-1', 'status:401'])
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
    expect(failure.message).toContain('connection refused')
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
