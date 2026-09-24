import type { EdgeDef } from 'server:core'
import { action, createServer, Edge, HEADERS, ServerErrors, service } from 'server:core'
import { Auth, Docs, StaticAuth } from 'server:plugins'
import { attempt, run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage, todos } from '../helpers'

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  Edge.actions.handle(new Request(`http://edge${path}`, { method, headers }))

const tokens = StaticAuth.use({
  tokens: {
    'tok-ui': { sub: 'ui', roles: ['admin'] },
    'tok-guest': { sub: 'guest' },
  },
})

/** Hands the principal it was given back as JSON. */
const whoami: EdgeDef.RawHandler = function* (_request, _params, { principal }) {
  return Response.json({ sub: principal?.sub ?? null })
}

const site = mkdtempSync(join(tmpdir(), 'oz-static-'))
const secret = mkdtempSync(join(tmpdir(), 'oz-secret-'))

mkdirSync(join(site, 'docs'))
mkdirSync(join(site, 'empty'))
writeFileSync(join(site, 'index.html'), '<h1>home</h1>')
writeFileSync(join(site, 'app.js'), 'console.log(1)')
writeFileSync(join(site, 'style.css'), 'body{}')
writeFileSync(join(site, 'data.bin'), new Uint8Array([1, 2, 3]))
writeFileSync(join(site, 'docs', 'index.html'), '<h1>docs</h1>')
writeFileSync(join(site, '.env'), 'SECRET=1')
writeFileSync(join(secret, 'key.txt'), 'top secret')
symlinkSync(secret, join(site, 'linked'))
symlinkSync(join(secret, 'key.txt'), join(site, 'key.txt'))

afterAll(() => {
  rmSync(site, { recursive: true, force: true })
  rmSync(secret, { recursive: true, force: true })
})

describe('edge — raw routes under Auth', () => {
  it('a fail-closed Auth default closes raw routes too; `auth: false` opens one; the principal reaches the handler', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [tokens, Auth.use({ default: 'authenticated' }), Docs],
        })
        yield* server.start()
        yield* Edge.actions.raw({ method: 'GET', path: '/private', handler: whoami })
        yield* Edge.actions.raw({ method: 'GET', path: '/public', auth: false, handler: whoami })
        yield* Edge.actions.raw({ method: 'GET', path: '/admin', auth: ['admin'], handler: whoami })

        // an action and a raw route agree: no bearer → 401
        expect((yield* get('/todos/list')).status).toBe(401)
        const closed = yield* get('/private')
        expect(closed.status).toBe(401)
        expect(closed.headers.get(HEADERS.error)).toBe(ServerErrors.Unauthorized)
        expect(yield* until((yield* get('/private', bearer('tok-ui'))).json())).toEqual({
          sub: 'ui',
        })
        expect((yield* get('/private', bearer('nope'))).status).toBe(401)

        // an own requirement gates like an action's
        expect((yield* get('/admin', bearer('tok-guest'))).status).toBe(403)
        expect((yield* get('/admin', bearer('tok-ui'))).status).toBe(200)

        // a public route stays open — anonymous, or with a bearer it still recognizes; a stale
        // bearer does not lock anyone out of it
        expect(yield* until((yield* get('/public')).json())).toEqual({ sub: null })
        expect(yield* until((yield* get('/public', bearer('tok-ui'))).json())).toEqual({
          sub: 'ui',
        })
        expect(yield* until((yield* get('/public', bearer('nope'))).json())).toEqual({ sub: null })

        // the built-in raw routes are public on purpose: health probes, the docs (no `auth`)
        expect((yield* get('/_health')).status).toBe(200)
        expect((yield* get('/docs/manifest')).status).toBe(200)
        expect((yield* get('/docs')).headers.get('content-type')).toContain('text/html')
        yield* server.stop()
      }),
    )
  })

  it('Docs `auth` gates its routes through the same seam', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [tokens, Auth, Docs.use({ auth: ['admin'] })],
        })
        yield* server.start()
        expect((yield* get('/docs/manifest')).status).toBe(401)
        expect((yield* get('/docs/manifest', bearer('tok-guest'))).status).toBe(403)
        expect((yield* get('/docs/manifest', bearer('tok-ui'))).status).toBe(200)
        yield* server.stop()
      }),
    )
  })

  it('without Auth installed a route that asks for auth is refused, an open one is served', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], edge: BunEdge })
        yield* server.start()
        yield* Edge.actions.raw({ method: 'GET', path: '/open', handler: whoami })
        yield* Edge.actions.raw({
          method: 'GET',
          path: '/closed',
          auth: 'authenticated',
          handler: whoami,
        })
        expect(yield* until((yield* get('/open')).json())).toEqual({ sub: null })
        expect((yield* get('/closed', bearer('anything'))).status).toBe(401)
        yield* server.stop()
      }),
    )
  })
})

describe('edge — output contract', () => {
  const broken = service('broken', {
    lie: action.query({ output: z.object({ n: z.number() }) }, function* () {
      return { n: 'not a number' } as AnyType
    }),
    strict: action.query({ input: z.object({ n: z.coerce.number() }) }, function* () {
      return 'ok'
    }),
  })

  it('an answer outside the declared output is `server.output` (500), not the caller’s 400', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [broken], edge: BunEdge })
        yield* server.start()
        const failed = yield* attempt(server.call(broken, 'lie'))
        expect((failed as AnyType).error).toBe(ServerErrors.Output)
        expect((failed as AnyType).error).toBe('server.output')
        const response = yield* get('/broken/lie')
        expect(response.status).toBe(500)
        expect(response.headers.get(HEADERS.error)).toBe('server.output')

        // the input side is still the caller's fault
        const invalid = yield* get('/broken/strict?n=abc')
        expect(invalid.status).toBe(400)
        expect(invalid.headers.get(HEADERS.error)).toBe(ServerErrors.Validation)
        yield* server.stop()
      }),
    )
  })
})

describe('edge — static directories', () => {
  it('serves files by content type, index for directories, 404 for missing, refuses escapes', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [todos], edge: BunEdge })
        yield* server.start()
        yield* Edge.actions.static({ path: '/assets/**', dir: site })

        const js = yield* get('/assets/app.js')
        expect(js.status).toBe(200)
        expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
        expect(yield* until(js.text())).toBe('console.log(1)')
        expect((yield* get('/assets/style.css')).headers.get('content-type')).toContain('text/css')
        const bin = yield* get('/assets/data.bin')
        expect(bin.headers.get('content-type')).toBe('application/octet-stream')
        expect(bin.headers.get('content-length')).toBe('3')
        expect([...new Uint8Array(yield* until(bin.arrayBuffer()))]).toEqual([1, 2, 3])

        // directories answer their index — the prefix itself included
        expect(yield* until((yield* get('/assets')).text())).toBe('<h1>home</h1>')
        expect(yield* until((yield* get('/assets/')).text())).toBe('<h1>home</h1>')
        expect(yield* until((yield* get('/assets/docs')).text())).toBe('<h1>docs</h1>')
        expect((yield* get('/assets/empty')).status).toBe(404)
        expect((yield* get('/assets/missing.txt')).status).toBe(404)

        // HEAD: the headers, no body
        const head = yield* get('/assets/app.js', {}, 'HEAD')
        expect(head.status).toBe(200)
        expect(head.headers.get('content-length')).toBe('14')
        expect(yield* until(head.text())).toBe('')

        // escapes: plain, percent-encoded, encoded slashes, backslashes, absolute — all 404
        const outside = `../${secret.split('/').pop()}/key.txt`
        for (const path of [
          `/assets/${outside}`,
          `/assets/%2e%2e/${outside}`,
          `/assets/..%2f..%2f..%2fetc%2fpasswd`,
          `/assets/..%5c..%5cetc%5cpasswd`,
          `/assets/%2f${secret.slice(1)}/key.txt`,
        ]) {
          const escaped = yield* get(path)
          expect(escaped.status).toBe(404)
          expect(yield* until(escaped.text())).not.toContain('top secret')
        }

        // dot-files are hidden by default
        expect((yield* get('/assets/.env')).status).toBe(404)

        // symlinks under `dir` may point outside it — refused unless `followSymlinks`
        for (const path of ['/assets/linked/key.txt', '/assets/key.txt']) {
          const linked = yield* get(path)
          expect(linked.status).toBe(404)
          expect(yield* until(linked.text())).not.toContain('top secret')
        }
        yield* Edge.actions.static({
          path: '/followed',
          dir: site,
          auth: false,
          followSymlinks: true,
        })
        expect(yield* until((yield* get('/followed/linked/key.txt')).text())).toBe('top secret')
        yield* server.stop()
      }),
    )
  })

  it('goes through the raw-route gate: Auth default applies, `auth` overrides', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({
          services: [todos],
          edge: BunEdge,
          plugins: [tokens, Auth.use({ default: 'authenticated' })],
        })
        yield* server.start()
        yield* Edge.actions.static({ path: '/private', dir: site })
        yield* Edge.actions.static({ path: '/', dir: site, auth: false, index: false })

        expect((yield* get('/private/app.js')).status).toBe(401)
        expect((yield* get('/private/app.js', bearer('tok-ui'))).status).toBe(200)
        expect((yield* get('/app.js')).status).toBe(200)
        expect((yield* get('/')).status).toBe(404)
        yield* server.stop()
      }),
    )
  })
})
