import { until } from 'std:effect'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

import { bootWizard, checkFrame, flakyState, httpJson, openProbe, targets } from './helpers'

for (const target of targets) {
  describe(`wizard realtime over ${target.label}`, () => {
    it('watch list → sync; insert/update/delete via HTTP → delta frames, version increasing', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 'w1', fn: 'list', args: {} })

        const sync = checkFrame(yield* until(probe.next()))
        const created = yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'live' },
        })
        const added = checkFrame(yield* until(probe.next()))

        yield* httpJson({
          url: `${info.url}/tasks/${created.body._id}`,
          method: 'PATCH',
          body: { done: true },
        })

        const changed = checkFrame(yield* until(probe.next()))

        yield* httpJson({ url: `${info.url}/tasks/${created.body._id}`, method: 'DELETE' })

        const removed = checkFrame(yield* until(probe.next()))

        probe.close()

        return { sync, added, changed, removed, id: created.body._id }
      })

      expect(result.sync).toMatchObject({ type: 'sync', id: 'w1', rows: [] })
      expect(result.added.type).toBe('delta')
      expect(result.added.added.map((row: AnyType) => row.title)).toEqual(['live'])
      expect(result.added.changed).toEqual([])
      expect(result.added.version).toBeGreaterThan(result.sync.version)
      expect(result.changed.changed.map((row: AnyType) => row.done)).toEqual([true])
      expect(result.changed.version).toBeGreaterThan(result.added.version)
      expect(result.removed.removed).toEqual([result.id])
    })

    it('watch honors the sanitized filter pipeline in args', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({
          event: 'watch',
          id: 'w1',
          fn: 'list',
          args: { filter: { op: 'eq', field: 'done', value: true } },
        })

        const sync = checkFrame(yield* until(probe.next()))

        // a non-matching insert produces NO frame; the matching one arrives as a delta
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'open' } })
        yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'closed', done: true },
        })

        const delta = checkFrame(yield* until(probe.next()))

        probe.close()

        return { sync, delta }
      })

      expect(result.sync.rows).toEqual([])
      expect(result.delta.added.map((row: AnyType) => row.title)).toEqual(['closed'])
    })

    it('since resume: matching version → no duplicate sync, next change → delta', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'first' } })

        const page = yield* httpJson({ url: `${info.url}/tasks` })
        const since = page.body.version as number

        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 'w1', fn: 'list', args: {}, since })

        const silent = yield* until(probe.idle(300))

        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'second' } })

        const delta = checkFrame(yield* until(probe.next()))

        probe.close()

        return { silent, delta, since }
      })

      expect(result.silent).toBe(true)
      expect(result.delta.type).toBe('delta')
      expect(result.delta.added.map((row: AnyType) => row.title)).toEqual(['second'])
      expect(result.delta.version).toBeGreaterThan(result.since)
    })

    it('stale since self-heals with a fresh full sync', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'a' } })
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'b' } })

        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 'w1', fn: 'list', args: {}, since: 1 })

        const sync = checkFrame(yield* until(probe.next()))

        probe.close()

        return sync
      })

      expect(result.type).toBe('sync')
      expect(result.rows.map((row: AnyType) => row.title).toSorted()).toEqual(['a', 'b'])
    })

    it('unwatch stops the frames', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 'w1', fn: 'list', args: {} })

        const sync = checkFrame(yield* until(probe.next()))

        probe.send({ event: 'unwatch', id: 'w1' })

        // give the unwatch a beat, then write — nothing may arrive
        yield* until(probe.idle(100))
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'quiet' } })

        const silent = yield* until(probe.idle(300))

        probe.close()

        return { sync, silent }
      })

      expect(result.sync.type).toBe('sync')
      expect(result.silent).toBe(true)
    })

    it('invalid frames → bad-frame error frame with requestId', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.sendRaw('not json at all')

        const garbage = checkFrame(yield* until(probe.next()))

        probe.send({ event: 'watch' })

        const missingFields = checkFrame(yield* until(probe.next()))

        probe.close()

        return { garbage, missingFields }
      })

      expect(result.garbage.type).toBe('error')
      expect(result.garbage.error).toBe('server:wizard.bad-frame')
      expect(result.garbage.requestId).toMatch(/^r_/u)
      expect(result.missingFields.error).toBe('server:wizard.bad-frame')
    })

    it('watch with a bad filter field → db.validation error frame, socket stays usable', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({
          event: 'watch',
          id: 'w1',
          fn: 'list',
          args: { filter: { op: 'eq', field: 'ghost', value: 1 } },
        })

        const error = checkFrame(yield* until(probe.next()))

        // the same socket can still start a valid watch afterwards
        probe.send({ event: 'watch', id: 'w2', fn: 'list', args: {} })

        const sync = checkFrame(yield* until(probe.next()))

        probe.close()

        return { error, sync }
      })

      expect(result.error).toMatchObject({ type: 'error', id: 'w1', error: 'db.validation' })
      expect(result.sync).toMatchObject({ type: 'sync', id: 'w2' })
    })

    it('watching a non-watchable fn → not-watchable error frame', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 'w1', fn: 'get', args: { id: 'x' } })

        const error = checkFrame(yield* until(probe.next()))

        probe.close()

        return error
      })

      expect(result).toMatchObject({
        type: 'error',
        id: 'w1',
        error: 'server:wizard.not-watchable',
      })
    })

    it('access guard applies before subscribing: forbidden error frame vs allowed sync', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const url = `ws://127.0.0.1:${info.port}/locked/_realtime`

        const denied = yield* until(openProbe(url))

        denied.send({ event: 'watch', id: 'w1', fn: 'list', args: {} })

        const error = checkFrame(yield* until(denied.next()))

        denied.close()

        const allowed = yield* until(openProbe(url, { 'x-role': 'admin' }))

        allowed.send({ event: 'watch', id: 'w1', fn: 'list', args: {} })

        const sync = checkFrame(yield* until(allowed.next()))

        allowed.close()

        return { error, sync }
      })

      expect(result.error).toMatchObject({
        type: 'error',
        id: 'w1',
        error: 'server:core.forbidden',
      })
      expect(result.sync).toMatchObject({ type: 'sync', id: 'w1', rows: [] })
    })

    it('runtime failure after live → terminal reset frame, watch ends, fresh watch recovers', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)

        flakyState.calls = 0

        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 'f1', fn: 'flaky' })

        const sync = checkFrame(yield* until(probe.next()))

        // the recompute this write triggers fails → the live watch must reset, not error
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'boom' } })

        const reset = checkFrame(yield* until(probe.next()))

        // the watch ended server-side: further writes produce NO frames for f1
        yield* httpJson({ url: `${info.url}/tasks`, method: 'POST', body: { title: 'silent' } })

        const silent = yield* until(probe.idle(300))

        // the client contract: resubscribe WITHOUT since → fresh sync
        flakyState.calls = 0
        probe.send({ event: 'watch', id: 'f2', fn: 'flaky' })

        const fresh = checkFrame(yield* until(probe.next()))

        probe.close()

        return { sync, reset, silent, fresh }
      })

      expect(result.sync).toMatchObject({ type: 'sync', id: 'f1', rows: [{ total: 0 }] })
      expect(result.reset).toEqual({ type: 'reset', id: 'f1' })
      expect(result.silent).toBe(true)
      expect(result.fresh).toMatchObject({ type: 'sync', id: 'f2', rows: [{ total: 2 }] })
    })

    it('custom reactive query: sync frames whose rows is [value]', async () => {
      const result = await runScoped(function* () {
        const info = yield* bootWizard(target)
        const probe = yield* until(openProbe(`ws://127.0.0.1:${info.port}/tasks/_realtime`))

        probe.send({ event: 'watch', id: 's1', fn: 'stats' })

        const initial = checkFrame(yield* until(probe.next()))

        yield* httpJson({
          url: `${info.url}/tasks`,
          method: 'POST',
          body: { title: 'n', done: true },
        })

        const updated = checkFrame(yield* until(probe.next()))

        probe.close()

        return { initial, updated }
      })

      expect(result.initial).toMatchObject({
        type: 'sync',
        id: 's1',
        rows: [{ total: 0, done: 0 }],
      })
      expect(result.updated.rows).toEqual([{ total: 1, done: 1 }])
      expect(result.updated.version).toBeGreaterThan(result.initial.version)
    })
  })
}
