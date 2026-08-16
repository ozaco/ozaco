import { realtimeWatchCount } from 'server:wizard'
import { sleep, until } from 'std:effect'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

import { bootWizard, checkFrame, flakyState, httpJson, openSse, targets } from './helpers'

for (const target of targets) {
  describe(`wizard realtime over SSE (${target.label})`, () => {
    it('GET /_realtime/sse?fn=list streams a sync frame, then deltas on writes', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openSse(`${info.url}/tasks/_realtime/sse?fn=list`))

        const sync = checkFrame(yield* until(probe.next()))

        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'live' } })

        const delta = checkFrame(yield* until(probe.next()))

        probe.abort()

        return {
          status: probe.status,
          type: probe.headers.get('content-type'),
          sync,
          delta,
        }
      })

      expect(result.status).toBe(200)
      expect(result.type).toContain('text/event-stream')
      expect(result.sync).toMatchObject({ type: 'sync', id: 'sse', rows: [] })
      expect(result.delta.type).toBe('delta')
      expect(result.delta.id).toBe('sse')
      expect(result.delta.added.map((row: AnyType) => row.title)).toEqual(['live'])
      expect(result.delta.version).toBeGreaterThan(result.sync.version)
    })

    it('client abort tears the server-side watch down — no leaked db watcher', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const before = realtimeWatchCount()
        const probe = yield* until(openSse(`${info.url}/tasks/_realtime/sse?fn=list`))

        checkFrame(yield* until(probe.next()))

        const during = realtimeWatchCount()

        probe.abort()

        // the response pump only notices the dead client on its next frame — poke it with a write
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'poke' } })

        let after = realtimeWatchCount()

        for (let waited = 0; waited < 4000 && after > before; waited += 50) {
          yield* sleep(50)

          after = realtimeWatchCount()
        }

        return { before, during, after }
      })

      expect(result.during).toBe(result.before + 1)
      expect(result.after).toBe(result.before)
    })

    it('since resume matches WS: no duplicate sync when current, next change → delta', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'first' } })

        const page = yield* httpJson({ url: `${info.url}/tasks` })
        const since = page.body.version as number
        const probe = yield* until(
          openSse(`${info.url}/tasks/_realtime/sse?fn=list&since=${since}`),
        )

        const silent = yield* until(probe.idle(300))

        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'second' } })

        const delta = checkFrame(yield* until(probe.next()))

        probe.abort()

        return { silent, delta, since }
      })

      expect(result.silent).toBe(true)
      expect(result.delta.type).toBe('delta')
      expect(result.delta.added.map((row: AnyType) => row.title)).toEqual(['second'])
      expect(result.delta.version).toBeGreaterThan(result.since)
    })

    it('subscribe-time failures map to the HTTP status before the stream starts', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        // guarded resource without authorization → 403, never a stream
        const denied = yield* until(openSse(`${info.url}/locked/_realtime/sse?fn=list`))

        // a fn that is not watchable → 404
        const missing = yield* until(openSse(`${info.url}/tasks/_realtime/sse?fn=get`))

        // malformed args JSON → 400
        const malformed = yield* until(
          openSse(`${info.url}/tasks/_realtime/sse?fn=list&args=not-json`),
        )

        // the same guarded resource WITH authorization streams normally
        const allowed = yield* until(
          openSse(`${info.url}/locked/_realtime/sse?fn=list`, { 'x-role': 'admin' }),
        )
        const sync = checkFrame(yield* until(allowed.next()))

        allowed.abort()

        return {
          deniedStatus: denied.status,
          deniedError: denied.body.error,
          missingStatus: missing.status,
          missingError: missing.body.error,
          malformedStatus: malformed.status,
          malformedError: malformed.body.error,
          sync,
        }
      })

      expect(result.deniedStatus).toBe(403)
      expect(result.deniedError).toBe('server:core.forbidden')
      expect(result.missingStatus).toBe(404)
      expect(result.missingError).toBe('server:wizard.not-watchable')
      expect(result.malformedStatus).toBe(400)
      expect(result.malformedError).toBe('server:wizard.bad-frame')
      expect(result.sync).toMatchObject({ type: 'sync', id: 'sse', rows: [] })
    })

    it('a live watch that breaks emits a terminal reset frame and ends the stream', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        flakyState.calls = 0

        const probe = yield* until(openSse(`${info.url}/tasks/_realtime/sse?fn=flaky`))
        const sync = checkFrame(yield* until(probe.next()))

        // this write triggers a failing recompute → reset, then the server closes the stream
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'boom' } })

        const reset = checkFrame(yield* until(probe.next()))
        const ended = yield* until(probe.closed())

        return { sync, reset, ended }
      })

      expect(result.sync).toMatchObject({ type: 'sync', id: 'sse', rows: [{ total: 0 }] })
      expect(result.reset).toEqual({ type: 'reset', id: 'sse' })
      expect(result.ended).toBe(true)
    })
  })
}
