import type { ClientDef } from 'client:core'
import { createClient } from 'client:core'
import { run, sleep } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

// `connectClient({ session })` / `client.$session`: the tokens every call carries, persisted
// where the app says, renewed before they expire — once, however many callers arrive.

/** A JWT-shaped token whose only claim is `exp` (seconds). */
const jwt = (expiresInMs: number, tag = 'a'): string => {
  const payload = btoa(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000), tag }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')

  return `h.${payload}.s`
}

const manifest: ClientDef.Options['manifest'] = {
  manifest: 'ozaco/2',
  name: 'session-test',
  version: '0.0.0',
  instance: 'i1',
  errors: {},
  services: [
    {
      name: 'auth',
      version: '0.0.0',
      actions: [
        {
          id: 'auth.refresh',
          service: 'auth',
          action: 'refresh',
          kind: 'mutation',
          route: { method: 'POST', path: '/auth/refresh' },
          input: { plane: 'value', brand: null, contentType: 'application/json', schema: {} },
          output: { plane: 'value', brand: null, contentType: 'application/json', schema: {} },
          errors: {},
          tags: [],
          options: {},
        },
      ],
    },
    {
      name: 'demo',
      version: '0.0.0',
      actions: [
        {
          id: 'demo.whoami',
          service: 'demo',
          action: 'whoami',
          kind: 'query',
          route: { method: 'GET', path: '/demo/whoami' },
          input: { plane: 'none', brand: null, contentType: null },
          output: { plane: 'value', brand: null, contentType: 'application/json', schema: {} },
          errors: {},
          tags: [],
          options: {},
        },
      ],
    },
  ],
}

/** A storage shaped like `localStorage`. */
const memoryStorage = (
  seed: Record<string, string> = {},
): ClientDef.TokenStorage & {
  readonly map: Map<string, string>
} => {
  const map = new Map(Object.entries(seed))

  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: key => {
      map.delete(key)
    },
  }
}

/** A server that answers `whoami` with the bearer it saw and `refresh` as `answer` says. */
const server = (answer: (refreshToken: string) => Response | 'network') => {
  const seen: { path: string; authorization: string | null }[] = []
  let refreshes = 0
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init?.headers)

    seen.push({ path: url.pathname, authorization: headers.get('authorization') })

    if (url.pathname === '/auth/refresh') {
      refreshes += 1

      const body = JSON.parse(String(init?.body)) as { refreshToken: string }
      const reply = answer(body.refreshToken)

      return reply === 'network'
        ? Promise.reject(new TypeError('ConnectionRefused'))
        : Promise.resolve(reply)
    }

    return Promise.resolve(Response.json({ authorization: headers.get('authorization') }))
  }) as unknown as typeof fetch

  return { seen, fetchImpl, refreshes: () => refreshes }
}

const session = (
  storage: ClientDef.TokenStorage,
  extra: Partial<ClientDef.SessionOptions> = {},
): ClientDef.SessionOptions => ({
  storage,
  keys: { access: 'acc', refresh: 'ref' },
  skewMs: 60_000,
  keepAlive: false,
  refresh: (client, refreshToken) => client.$call('auth.refresh', { refreshToken }) as AnyType,
  ...extra,
})

describe('client — session', () => {
  it('renews an expiring access token before the call goes out, once for concurrent callers, and persists the pair', async () => {
    const storage = memoryStorage({ acc: jwt(10_000, 'old'), ref: 'r1' })
    const fresh = jwt(3_600_000, 'new')
    const api = server(() => Response.json({ accessToken: fresh, refreshToken: 'r2' }))

    const result = unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          fetch: api.fetchImpl,
          session: session(storage),
        })

        expect(client.$session.status()).toBe('active')
        expect(client.$session.expiresAt()).toBeGreaterThan(Date.now())

        // two calls at once share ONE renewal
        const [first, second] = yield* client.$scope.run(function* () {
          const a = client.$call('demo.whoami')
          const b = client.$call('demo.whoami')

          return [yield* a, yield* b]
        })

        return {
          first,
          second,
          token: client.$session.token(),
          refresh: client.$session.refreshToken(),
          claims: client.$session.claims<{ tag: string }>(),
        }
      }),
    )

    expect(api.refreshes()).toBe(1)
    expect(result.claims?.tag).toBe('new')
    expect(result.first).toEqual({ authorization: `Bearer ${fresh}` })
    expect(result.second).toEqual({ authorization: `Bearer ${fresh}` })
    expect(result.token).toBe(fresh)
    expect(result.refresh).toBe('r2')
    expect(storage.map.get('acc')).toBe(fresh)
    expect(storage.map.get('ref')).toBe('r2')
  })

  it('a refused refresh ends the session; a network fault keeps the pair; a fresh token is left alone', async () => {
    const refused = memoryStorage({ acc: jwt(10_000), ref: 'r1' })
    const refusing = server(() =>
      Response.json({ error: { error: 'server.unauthorized' } }, { status: 401 }),
    )
    const statuses: string[] = []

    unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          fetch: refusing.fetchImpl,
          session: session(refused),
        })

        client.$session.subscribe(status => {
          statuses.push(status)
        })

        expect(yield* client.$session.renew()).toBe(false)
        expect(client.$session.status()).toBe('anonymous')
        expect(client.$session.token()).toBeNull()
        // the call then goes out anonymous
        expect(yield* client.$call('demo.whoami')).toEqual({ authorization: null })
      }),
    )

    expect(statuses).toEqual(['anonymous'])
    expect(refused.map.has('acc')).toBe(false)

    const offline = memoryStorage({ acc: jwt(10_000, 'kept'), ref: 'r1' })
    const down = server(() => 'network')

    unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          fetch: down.fetchImpl,
          session: session(offline),
        })

        expect(yield* client.$session.renew()).toBe(false)
        expect(client.$session.status()).toBe('active')
        expect(offline.map.get('ref')).toBe('r1')
      }),
    )

    const fine = memoryStorage({ acc: jwt(3_600_000, 'fine'), ref: 'r1' })
    const idle = server(() => Response.json({ accessToken: 'never' }))

    unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          fetch: idle.fetchImpl,
          session: session(fine),
        })

        yield* client.$call('demo.whoami')
      }),
    )

    expect(idle.refreshes()).toBe(0)
  })

  it('without session options the session is memory-only: $setToken writes it, the token option answers until then', async () => {
    const api = server(() => Response.json({}))

    unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          fetch: api.fetchImpl,
          token: 'from-option',
        })

        expect(yield* client.$call('demo.whoami')).toEqual({ authorization: 'Bearer from-option' })
        client.$setToken('set-later')
        expect(yield* client.$call('demo.whoami')).toEqual({ authorization: 'Bearer set-later' })
        client.$setToken(null)
        expect(yield* client.$call('demo.whoami')).toEqual({ authorization: null })
        expect(client.$session.status()).toBe('anonymous')
        // an opaque token has no claims to read
        client.$setToken('opaque')
        expect(client.$session.claims()).toBeNull()
      }),
    )
  })

  it('keepAlive renews in the background before the token expires', async () => {
    const storage = memoryStorage({ acc: jwt(200), ref: 'r1' })
    const fresh = jwt(3_600_000, 'bg')
    const api = server(() => Response.json({ accessToken: fresh }))

    unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          fetch: api.fetchImpl,
          session: session(storage, { skewMs: 100, keepAlive: true }),
        })

        yield* sleep(250)
        expect(client.$session.token()).toBe(fresh)
      }),
    )

    expect(api.refreshes()).toBe(1)
  })
})
