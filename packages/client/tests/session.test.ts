import { connectSession, createSession } from 'client:core'
import type { FrameLog } from 'client:core'
import { run, sleep, until, withResolvers } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { bootClientEnv, bootServer, deferred, withTimeout } from './helpers'

/**
 * The INSPECTOR surface against a real wizard server — what the typed client hides: full response
 * metadata with an unread body, manifest addressing (and pinned request lines), multipart uploads,
 * the observable realtime frame timeline and the SSE flavor.
 */

/**
 * Keep a booted server alive across plain-async work: the gateway is scope-bound, so a `run()`
 * that returns immediately takes the server down with it.
 */
const withServer = async <T>(body: (url: string) => Promise<T>): Promise<T> => {
  const gate = withResolvers<void>('test:server-close')

  let ready: (url: string) => void = () => {}
  const url = new Promise<string>(resolve => {
    ready = resolve
  })

  const task = run(function* () {
    const info = yield* bootServer()

    ready(info.url)

    yield* gate.operation
  })

  try {
    return await body(await url)
  } finally {
    gate.resolve()
    await task
  }
}

describe('inspector session', () => {
  it('resolves the manifest, caches it, and re-reads it on refresh', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })
        const first = yield* session.manifest()
        const cached = yield* session.manifest()
        const refreshed = yield* session.manifest({ refresh: true })

        return { first, cached, refreshed }
      }),
    )

    expect(result.first?.ozaco).toBe('1.0')
    expect(Object.keys(result.first?.services ?? {})).toContain('tasks')
    // the cached read hands back the very same document object …
    expect(result.cached).toBe(result.first)
    // … while a refresh re-reads it from the server (equal content, fresh object)
    expect(result.refreshed).not.toBe(result.first)
    expect(result.refreshed).toEqual(result.first)
  })

  it('reports status, headers, x-request-id and timing — with the body still unread', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })
        const created = yield* session.request({
          resource: 'tasks',
          fn: 'create',
          args: { title: 'inspect me' },
        })
        const body = yield* created.response.json<{ _id: string; title: string }>()

        return { created, body }
      }),
    )

    expect(result.created.status).toBe(201)
    expect(result.created.ok).toBe(true)
    expect(result.created.kind).toBe('json')
    expect(result.created.requestId).not.toBeNull()
    expect(result.created.headers.get('content-type')).toContain('json')
    expect(result.created.elapsedMs).toBeGreaterThanOrEqual(0)

    // the wire truth is reported, not guessed at
    expect(result.created.sent.method).toBe('POST')
    expect(result.created.sent.bodyKind).toBe('json')
    expect(result.created.sent.url).toContain('/tasks')

    // the body was NOT consumed by the inspector — the caller reads it
    expect(result.body.title).toBe('inspect me')
  })

  it('addresses through the manifest, and a pinned request line always wins', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })
        const address = yield* session.address('tasks', 'list')
        // the manifest route is GET /tasks: leftover args ride the query string
        const listed = yield* session.request({
          resource: 'tasks',
          fn: 'list',
          args: { limit: 1 },
        })
        // pinning overrides the manifest entirely
        const pinned = yield* session.request({ method: 'get', path: '/tasks', args: { limit: 1 } })

        return { address, listed, pinned }
      }),
    )

    expect(result.address).toEqual({ method: 'GET', path: '/tasks' })
    expect(result.listed.sent.method).toBe('GET')
    expect(result.listed.sent.url).toContain('?limit=1')
    expect(result.listed.sent.bodyKind).toBe('none')
    expect(result.listed.status).toBe(200)

    expect(result.pinned.sent.method).toBe('GET')
    expect(result.pinned.sent.url).toContain('/tasks?limit=1')
    expect(result.pinned.status).toBe(200)
  })

  it('keeps a failing response as a response — nothing is raised, everything is readable', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })
        const missing = yield* session.request({
          resource: 'tasks',
          fn: 'get',
          args: { id: 'nope' },
        })
        const body = yield* missing.response.json<{ error: string; requestId: string }>()

        return { missing, body }
      }),
    )

    // a 404 is DATA for an inspector: the typed client would have raised here
    expect(result.missing.status).toBe(404)
    expect(result.missing.ok).toBe(false)
    expect(result.body.error).toBe('server:wizard.not-found')
    expect(result.missing.requestId).toBe(result.body.requestId)
  })

  it('sends attachments as multipart with the fields written before the files', async () => {
    const sent = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })
        const response = yield* session.request({
          resource: 'tasks',
          fn: 'create',
          args: { title: 'with an attachment', done: true },
          files: [{ field: 'doc', file: new Blob(['hello']), filename: 'doc.txt' }],
        })

        return response.sent
      }),
    )

    expect(sent.bodyKind).toBe('multipart')
    // the browser (not us) must set the boundary, so no content-type is pinned
    expect(sent.headers['content-type']).toBeUndefined()
    expect(sent.body).toBeInstanceOf(FormData)

    const form = sent.body as FormData
    const keys = [...form.keys()]

    expect(keys).toEqual(['title', 'done', 'doc'])
    expect(form.get('title')).toBe('with an attachment')
    // non-string field values travel as JSON
    expect(form.get('done')).toBe('true')
    expect((form.get('doc') as File).name).toBe('doc.txt')
  })

  it('merges explicit headers OVER the session token', async () => {
    const sent = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url, token: 'session-token' })
        const response = yield* session.request({
          resource: 'tasks',
          fn: 'list',
          headers: { authorization: 'Bearer override', 'x-panel': '1' },
        })

        return response.sent
      }),
    )

    expect(sent.headers['authorization']).toBe('Bearer override')
    expect(sent.headers['x-panel']).toBe('1')
  })

  it('opens a realtime link whose frames are observable in both directions', async () => {
    const frames: FrameLog[] = []
    const synced = deferred<readonly unknown[]>()

    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })

        yield* session.request({ resource: 'tasks', fn: 'create', args: { title: 'watched' } })

        const link = yield* session.realtime({ resource: 'tasks' })

        link.tap(frame => {
          frames.push(frame)
        })

        const watch = yield* link.watch({
          fn: 'list',
          args: {},
          onRows: rows => {
            synced.resolve(rows)
          },
        })

        const rows = yield* until(withTimeout(synced.promise))

        return { rows, status: link.status(), version: watch.version(), id: watch.id }
      }),
    )

    expect(result.status).toBe('open')
    expect(result.rows).toHaveLength(1)
    expect(result.version).toBeGreaterThanOrEqual(0)

    // the timeline saw our own `watch` frame go out and the `sync` frame come back
    const out = frames.filter(frame => frame.dir === 'out')
    const inbound = frames.filter(frame => frame.dir === 'in')

    expect(out.some(frame => frame.text.includes('"event":"watch"'))).toBe(true)
    expect(out.some(frame => frame.text.includes(`"id":"${result.id}"`))).toBe(true)
    expect(inbound.some(frame => frame.text.includes('"type":"sync"'))).toBe(true)
  })

  it('keeps an explicitly opened link alive when its last watch stops', async () => {
    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })
        const link = yield* session.realtime({ resource: 'tasks' })
        const first = yield* link.watch({ fn: 'list', args: {}, onRows: () => {} })

        yield* first.stop()

        const afterStop = link.status()
        // the socket is still up, so a fresh watch needs no redial
        const second = yield* link.watch({ fn: 'list', args: {}, onRows: () => {} })

        yield* second.stop()
        yield* link.close()

        return { afterStop, afterClose: link.status() }
      }),
    )

    expect(result.afterStop).toBe('open')
    expect(result.afterClose).toBe('closed')
  })

  it('reads the SSE flavor, bearer header and all', async () => {
    const opened = deferred<unknown>()
    const comments: string[] = []

    const result = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        const session = yield* createSession({ url: info.url })

        yield* session.request({ resource: 'tasks', fn: 'create', args: { title: 'streamed' } })

        const stream = yield* session.sse({
          resource: 'tasks',
          fn: 'list',
          args: {},
          onValue: value => {
            opened.resolve(value)
          },
          onComment: comment => {
            comments.push(comment)
          },
        })

        const first = yield* until(withTimeout(opened.promise))

        yield* stream.stop()

        return { url: stream.url, first }
      }),
    )

    expect(result.url).toContain('/_realtime/sse?fn=list')
    // the edge opens every stream with a `: ok` comment, then emits frames
    expect(comments).toContain('ok')
    expect((result.first as { type: string }).type).toBe('sync')
  })

  it('drives the async facade: manifest, request, and cancel mid-flight', async () => {
    await withServer(async url => {
      const { session, close } = await connectSession({ url })

      try {
        const manifest = await session.manifest()

        expect(manifest?.ozaco).toBe('1.0')

        const listing = session.request({ resource: 'tasks', fn: 'list' })
        const listed = await listing.done

        expect(listed.status).toBe(200)

        // the body outlives `done` — that is what the open handle buys
        const page = (await listed.native.json()) as { data: readonly unknown[] }

        expect(Array.isArray(page.data)).toBe(true)

        await listing.close()

        // cancelling halts the request task; `done` settles with the halt, never a response
        const inflight = session.request({ resource: 'tasks', fn: 'list' })

        await inflight.cancel()

        const settled = await inflight.done.then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        )

        expect(settled).toBe('rejected')
      } finally {
        await close()
      }
    })
  })

  it('falls back to POST /<resource>/<fn> when no manifest is served', async () => {
    const sent = unwrap(
      await run(function* () {
        const info = yield* bootServer()

        yield* bootClientEnv()

        // point the docs path at nothing: manifest resolution settles to null
        const session = yield* createSession({ url: info.url, docsPath: '/no-such-docs' })
        const manifest = yield* session.manifest()

        expect(manifest).toBeNull()

        const address = yield* session.address('tasks', 'whatever')

        yield* sleep(0)

        return address
      }),
    )

    expect(sent).toEqual({ method: 'POST', path: '/tasks/whatever' })
  })
})
