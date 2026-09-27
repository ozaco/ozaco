import { race, sleep, spawn, suspend } from 'std:effect'
import { ResultErrors, fail, isFailure } from 'std:result'
import type { TraceDef } from 'std:trace'
import { current, emitLog, parseTraceparent, recordFailure, span, startSpan } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { traced, tracedResult } from './helpers'

const REMOTE = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')!

describe('span lifecycle', () => {
  it('a root span: new trace, sampled + random flags, defaults', async () => {
    const { tracer, value } = await traced(() =>
      span('root', function* () {
        return 42
      }),
    )

    expect(value).toBe(42)

    const root = tracer.span('root')
    expect(root.parent).toBeNull()
    expect(root.context.flags).toBe(3)
    expect(root.kind).toBe('internal')
    expect(root.service).toBeNull()
    // no scope, no service, no parent: the caller's own code — never `@ozaco/std`
    expect(root.scope).toEqual({ name: 'app' })
    expect(root.status).toEqual({ code: 'unset' })
    expect(root.end).toBeGreaterThanOrEqual(root.start)
    expect(root.context.state).toBeUndefined()
  })

  it('children share the trace, point at their parent, inherit the service', async () => {
    const { tracer } = await traced(() =>
      span('root', { service: 'todos', kind: 'server' }, () =>
        span('child', { kind: 'client', scope: { name: 'db', version: '1' } }, () =>
          span('grandchild', { service: 'other' }, function* () {}),
        ),
      ),
    )

    const root = tracer.span('root')
    const child = tracer.span('child')
    const grandchild = tracer.span('grandchild')

    expect(child.context.traceId).toBe(root.context.traceId)
    expect(grandchild.context.traceId).toBe(root.context.traceId)
    expect(child.parent).toEqual({
      traceId: root.context.traceId,
      spanId: root.context.spanId,
      flags: 3,
    })
    expect(grandchild.parent?.spanId).toBe(child.context.spanId)

    expect(root.kind).toBe('server')
    expect(child.kind).toBe('client')
    expect(child.scope).toEqual({ name: 'db', version: '1' })
    expect(root.service).toBe('todos')
    expect(child.service).toBe('todos')
    expect(grandchild.service).toBe('other')

    // children are exported before their parents
    expect(tracer.names()).toBe('grandchild, child, root')
  })

  it('the two-argument form works like the three-argument one', async () => {
    const { tracer } = await traced(() => span('short', function* () {}))
    expect(tracer.span('short').kind).toBe('internal')
  })

  it('an explicit remote parent continues its trace as a local root', async () => {
    const { tracer } = await traced(() =>
      span('outer', () => span('handler', { parent: REMOTE, kind: 'server' }, function* () {})),
    )

    const handler = tracer.span('handler')
    const outer = tracer.span('outer')

    expect(handler.context.traceId).toBe(REMOTE.traceId)
    expect(handler.parent).toEqual({ ...REMOTE, remote: true })
    // the inbound flags carried no random bit: none is added
    expect(handler.context.flags).toBe(1)
    expect(outer.context.traceId).not.toBe(REMOTE.traceId)
  })

  it('an explicit parent equal to the active span stays an in-process child', async () => {
    const { tracer } = await traced(() =>
      span('outer', function* (outer) {
        yield* span('inner', { parent: outer.context }, function* () {})
      }),
    )

    expect(tracer.span('inner').parent).toEqual({
      traceId: tracer.span('outer').context.traceId,
      spanId: tracer.span('outer').context.spanId,
      flags: 3,
    })
  })

  it('parent: null forces a new trace under an active span', async () => {
    const { tracer } = await traced(() =>
      span('outer', () => span('fresh', { parent: null }, function* () {})),
    )

    expect(tracer.span('fresh').parent).toBeNull()
    expect(tracer.span('fresh').context.traceId).not.toBe(tracer.span('outer').context.traceId)
  })

  it('an invalid explicit parent starts a new trace', async () => {
    const { tracer } = await traced(() =>
      span('odd', { parent: { traceId: 'nope', spanId: 'nope', flags: 1 } }, function* () {}),
    )

    expect(tracer.span('odd').parent).toBeNull()
  })

  it('attributes: set, flatten, drop null / undefined, arrays', async () => {
    const { tracer } = await traced(() =>
      span('attrs', { attributes: { 'http.route': '/todos', skipped: undefined } }, function* (s) {
        s.setAttributes({
          count: 3,
          ok: true,
          tags: ['a', 'b'],
          sizes: [1, 2],
          flags: [true, false],
          mixed: [1, 'a', null],
          objects: [{ a: 1 }],
          empty: null,
          when: new Date(0),
          big: 12n,
          user: { id: 7, address: { city: 'x', geo: { lat: 1, deep: { deeper: true } } } },
        })
        s.setAttribute('single', 'value')
        s.setAttribute('count', 4)
      }),
    )

    expect(tracer.span('attrs').attributes).toEqual({
      'http.route': '/todos',
      count: 4,
      ok: true,
      tags: ['a', 'b'],
      sizes: [1, 2],
      flags: [true, false],
      mixed: ['1', 'a', 'null'],
      objects: '[{"a":1}]',
      when: '1970-01-01T00:00:00.000Z',
      big: '12',
      'user.id': 7,
      'user.address.city': 'x',
      'user.address.geo.lat': 1,
      'user.address.geo.deep': '{"deeper":true}',
      single: 'value',
    })
  })

  it('limits: 128 attributes, values capped at 2048 UTF-8 bytes', async () => {
    const { tracer } = await traced(() =>
      span('limits', function* (s) {
        const many: Record<string, number> = {}
        for (let at = 0; at < 140; at += 1) {
          many[`k${at}`] = at
        }
        s.setAttributes(many)
        // overwriting a kept key is never dropped
        s.setAttribute('k0', -1)
      }),
    )

    const data = tracer.span('limits')
    expect(Object.keys(data.attributes)).toHaveLength(128)
    expect(data.droppedAttributes).toBe(12)
    expect(data.attributes.k0).toBe(-1)

    const { tracer: long } = await traced(() =>
      span('long', function* (s) {
        s.setAttributes({
          ascii: 'x'.repeat(5000),
          wide: 'ğ'.repeat(3000),
          list: ['y'.repeat(3000)],
        })
      }),
    )

    const attributes = long.span('long').attributes
    const bytes = (text: unknown) => new TextEncoder().encode(String(text)).length
    expect(bytes(attributes.ascii)).toBeLessThanOrEqual(2048)
    expect(bytes(attributes.wide)).toBeLessThanOrEqual(2048)
    expect(String(attributes.wide).endsWith('…')).toBe(true)
    expect(bytes((attributes.list as string[])[0])).toBeLessThanOrEqual(2048)
  })

  it('events: name, time, attributes; 128 per span, the rest counted', async () => {
    const { tracer } = await traced(() =>
      span('events', function* (s) {
        s.addEvent('first', { 'ozaco.step': 1 })
        s.addEvent('timed', undefined, 1234.5)
        for (let at = 0; at < 130; at += 1) {
          s.addEvent(`e${at}`)
        }
      }),
    )

    const data = tracer.span('events')
    expect(data.events).toHaveLength(128)
    expect(data.droppedEvents).toBe(4)
    // exported in time order: the explicitly-timed (earlier) event first
    expect(data.events[0]).toEqual({ name: 'timed', time: 1234.5 })
    expect(data.events[1]).toMatchObject({ name: 'first', attributes: { 'ozaco.step': 1 } })
    expect(data.events[1]!.time).toBeGreaterThanOrEqual(data.start)
    expect(data.events[1]!.time).toBeLessThanOrEqual(data.end)
  })

  it('events are exported sorted by time — an exception recorded at its failure time included', async () => {
    const { tracer } = await tracedResult(() =>
      span('sorted', function* (s) {
        const failure = fail('app.early', 'failed before the event')
        yield* sleep(3)
        s.addEvent('late')
        s.addEvent('same-a', undefined, 5)
        s.addEvent('same-b', undefined, 5)
        return yield* failure
      }),
    )

    const data = tracer.span('sorted')
    const times = data.events.map(event => event.time)
    expect(times).toEqual(times.toSorted((left, right) => left - right))
    // equal times keep the order they were added in
    expect(data.events.slice(0, 2).map(event => event.name)).toEqual(['same-a', 'same-b'])
    // the exception sits at the failure's (clamped) time: before `late`, not appended after it
    expect(data.events.slice(2).map(event => event.name)).toEqual(['exception', 'late'])
  })

  it("exception events stay under the cap too, displacing the span code's own events", async () => {
    const { tracer } = await traced(() =>
      span('busy', function* (s) {
        for (let at = 0; at < 128; at += 1) {
          s.addEvent(`e${at}`)
        }
        for (let at = 0; at < 200; at += 1) {
          yield* recordFailure(fail('app.flaky', `attempt ${at}`), { handled: true })
        }
      }),
    )

    const data = tracer.span('busy')
    expect(data.events).toHaveLength(128)
    // every user event gave way first, then the exceptions past the cap were counted dropped
    expect(data.events.every(item => item.name === 'exception')).toBe(true)
    expect(data.droppedEvents).toBe(200)
    // the log records are not capped: one per recorded failure
    expect(tracer.exceptions()).toHaveLength(200)
  })

  it('a hostile Error (throwing getters) never breaks the span nor replaces the failure', async () => {
    const hostile = new Error('hidden')
    for (const key of ['stack', 'message', 'name', 'code', 'cause']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`no ${key} for you`)
        },
      })
    }

    const { tracer, result } = await tracedResult(() =>
      span('hostile', function* () {
        throw hostile
      }),
    )

    // folded by `asFailure`: the hostile Error kept as the fold's raw, untouched
    expect(isFailure(result) && result.error).toBe(ResultErrors.Unknown)
    expect(isFailure(result) && result.raw).toBe(hostile)
    expect(tracer.span('hostile').status.code).toBe('error')
    expect(tracer.exceptions()).toHaveLength(1)
  })

  it('an attribute whose getter throws is dropped alone, never failing the span code', async () => {
    const hostile = {
      ok: 1,
      get bad(): string {
        throw new Error('getter')
      },
    }

    const { tracer, value } = await traced(() =>
      span('guarded', { attributes: hostile }, function* (s) {
        s.setAttributes(hostile)
        s.addEvent('step', hostile)
        return 42
      }),
    )

    expect(value).toBe(42)
    const data = tracer.span('guarded')
    expect(data.attributes).toEqual({ ok: 1 })
    expect(data.events[0]?.attributes).toEqual({ ok: 1 })
  })

  it('non-finite numbers reach the Tracer as strings on spans, events, links and logs', async () => {
    const odd = { ratio: 0 / 0, max: Number.POSITIVE_INFINITY, min: Number.NEGATIVE_INFINITY }
    const expected = { ratio: 'NaN', max: 'Infinity', min: '-Infinity' }

    const { tracer } = await traced(() =>
      span(
        'odd',
        { attributes: odd, links: [{ context: REMOTE, attributes: odd }] },
        function* (s) {
          s.setAttributes({ late: Number.NaN })
          s.addEvent('step', odd)
          s.addLink(REMOTE, odd)
          yield* emitLog({ body: 'odd', severityNumber: 9, attributes: odd })
        },
      ),
    )

    const data = tracer.span('odd')
    expect(data.attributes).toMatchObject({ ...expected, late: 'NaN' })
    expect(data.events[0]?.attributes).toEqual(expected)
    expect(data.links.map(link => link.attributes)).toEqual([expected, expected])
    expect(tracer.logs[0]?.attributes).toEqual(expected)
  })

  it('event attributes are limited on their own', async () => {
    const { tracer } = await traced(() =>
      span('event-attrs', function* (s) {
        const many: Record<string, number> = {}
        for (let at = 0; at < 130; at += 1) {
          many[`k${at}`] = at
        }
        s.addEvent('wide', many)
      }),
    )

    const [event] = tracer.span('event-attrs').events
    expect(Object.keys(event!.attributes ?? {})).toHaveLength(128)
    expect(event!.droppedAttributes).toBe(2)
  })

  it('links: from options and addLink; invalid contexts ignored; 128 per span', async () => {
    const other: TraceDef.SpanContext = {
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
      flags: 1,
    }

    const { tracer } = await traced(() =>
      span(
        'links',
        {
          links: [
            { context: other, attributes: { 'ozaco.link.reason': 'creation' } },
            { context: { traceId: 'bad', spanId: 'bad', flags: 0 } },
          ],
        },
        function* (s) {
          s.addLink(REMOTE, { 'ozaco.link.reason': 'remote.parent' })
          for (let at = 0; at < 130; at += 1) {
            s.addLink(other)
          }
        },
      ),
    )

    const data = tracer.span('links')
    expect(data.links).toHaveLength(128)
    expect(data.droppedLinks).toBe(4)
    expect(data.links[0]).toEqual({
      context: other,
      attributes: { 'ozaco.link.reason': 'creation' },
    })
    expect(data.links[1]).toEqual({
      context: { ...REMOTE, remote: true },
      attributes: { 'ozaco.link.reason': 'remote.parent' },
    })
    expect(data.links[2]).toEqual({ context: other })
  })

  it('status, name updates; mutations after the end are ignored', async () => {
    let late: TraceDef.SpanHandle | undefined

    const { tracer } = await traced(() =>
      span('before', function* (s) {
        s.setStatus({ code: 'error', message: 'bad' })
        s.updateName('after')
        late = s
      }),
    )

    late!.setAttributes({ late: true })
    late!.addEvent('late')
    late!.updateName('too-late')
    late!.setStatus({ code: 'unset' })

    const data = tracer.span('after')
    expect(data.status).toEqual({ code: 'error', message: 'bad' })
    expect(data.attributes).toEqual({})
    expect(data.events).toEqual([])
  })

  it('startTime is honoured; children run inside their parent on the anchored clock', async () => {
    const { tracer } = await traced(() =>
      span('root', function* () {
        yield* sleep(2)
        yield* span('child', function* () {
          yield* sleep(2)
        })
        yield* span('backdated', { startTime: 1000 }, function* () {})
      }),
    )

    const root = tracer.span('root')
    const child = tracer.span('child')

    expect(child.start).toBeGreaterThanOrEqual(root.start)
    expect(child.end).toBeLessThanOrEqual(root.end)
    expect(child.end - child.start).toBeGreaterThanOrEqual(1)
    expect(tracer.span('backdated').start).toBe(1000)
    // wall-clock anchored: close to Date.now()
    expect(Math.abs(root.start - Date.now())).toBeLessThan(5000)
  })

  it('a failure RETURNED by the body fails the span and is returned as-is', async () => {
    const failure = fail('app.nope', 'returned')

    const { tracer, value } = await traced(function* () {
      const returned = yield* span('returns', function* () {
        return failure
      })
      return { returned }
    })

    expect(value.returned).toBe(failure)
    expect(tracer.span('returns').status).toEqual({ code: 'error', message: 'returned' })
    expect(tracer.exceptions()).toHaveLength(1)
  })

  it('a halted span is cancelled: ozaco.cancelled, status unset, no exception', async () => {
    const { tracer } = await traced(() =>
      race([
        span('slow', function* () {
          yield* suspend()
        }),
        sleep(1),
      ]),
    )

    const slow = tracer.span('slow')
    expect(slow.attributes['ozaco.cancelled']).toBe(true)
    expect(slow.status).toEqual({ code: 'unset' })
    expect(tracer.exceptions()).toHaveLength(0)
  })
})

describe('startSpan (LiveSpan)', () => {
  it('runs code with the span active and ends when told to (idempotent)', async () => {
    const { tracer, value } = await traced(function* (memory) {
      const live = yield* startSpan('stream', { kind: 'server' })

      const inside = yield* live.run(function* () {
        yield* span('chunk', function* () {})
        return (yield* current()).context.spanId
      })

      expect(memory.names()).toBe('chunk')

      yield* sleep(1)
      yield* live.end()
      yield* live.end({ failure: fail('ignored', 'already ended') })

      return { inside, id: live.context.spanId }
    })

    expect(value.inside).toBe(value.id)
    expect(tracer.names()).toBe('chunk, stream')
    expect(tracer.span('stream').status).toEqual({ code: 'unset' })
    expect(tracer.span('chunk').parent?.spanId).toBe(value.id)
  })

  it('end({ failure }) fails it, end({ cancelled }) cancels it, end({ time }) stamps it', async () => {
    const { tracer } = await traced(function* () {
      const failing = yield* startSpan('failing', { kind: 'client' })
      yield* failing.end({ failure: fail('rpc.down', 'lane closed') })

      const cancelled = yield* startSpan('cancelled')
      yield* cancelled.end({ cancelled: true })

      const stamped = yield* startSpan('stamped', { startTime: 10 })
      yield* stamped.end({ time: 20 })
    })

    expect(tracer.span('failing').status).toEqual({ code: 'error', message: 'lane closed' })
    expect(tracer.span('failing').attributes['error.type']).toBe('rpc.down')
    expect(tracer.span('cancelled').attributes['ozaco.cancelled']).toBe(true)
    expect(tracer.span('stamped')).toMatchObject({ start: 10, end: 20 })
  })

  it('a span started in one task can be ended from another', async () => {
    const { tracer } = await traced(function* () {
      const live = yield* startSpan('detached')
      const task = yield* spawn(function* () {
        yield* sleep(1)
        yield* live.end()
      })
      yield* task
    })

    expect(tracer.span('detached').status.code).toBe('unset')
  })
})
