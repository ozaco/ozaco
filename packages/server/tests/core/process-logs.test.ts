/**
 * An observing node claims the PROCESS's log records (`observe.processLogs`, std:trace's process
 * fallback): lines logged where no Trace sink records — infrastructure (transport, db) installed
 * BEFORE the node, in a parent scope — reach its exporters with its resource. One node per
 * process takes them; the next takes over when it stops. With `DefaultLogger` + `TraceTransport`
 * at the root, every line is exactly ONE record.
 */
import type { ObserveDef, ServerDef } from 'server:core'
import { action, createServer, ObserveExporter, Server, service } from 'server:core'
import type { Operation, Scope } from 'std:effect'
import { run, scoped, sleep, useContext, useScope, within } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { definePlugin } from 'std:plugin'
import { fail, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { TraceTransport } from 'std:logger/transport/trace'
import { createLink, MemoryTransport, setStatus } from 'transport:impl/memory'

import { storage } from '../helpers'

let installs = 0

/** An in-memory exporter: every observed event of the node it is installed on. */
const memoryExporter = () => {
  installs += 1

  const events: ObserveDef.Event[] = []

  const plugin = ObserveExporter.implement<ObserveDef.ExporterContext, []>({
    name: `test/process-logs-exporter-${installs}`,
    version: '1.0.0',
    *setup() {
      return { exporter: 'memory' }
    },
  }).build({
    *export(event: ObserveDef.Event) {
      events.push(event)
    },
    *start() {},
    *flush() {},
  })

  const logs = (): (TraceDef.LogData & { resource: ObserveDef.Resource })[] =>
    events.flatMap(event => (event.t === 'log' ? [{ ...event.log, resource: event.resource }] : []))

  const bodies = (): string[] => logs().map(log => log.body)

  const byBody = (body: string) => logs().filter(log => log.body === body)

  return { plugin, events, logs, bodies, byBody }
}

const shop = service('shop', {
  hello: action.query({}, function* () {
    yield* Logger.actions.info('inside the node')

    return 'hi'
  }),
})

/** Wait (bounded) until `check()` holds — for lines a background loop logs. */
function* until(check: () => boolean, ms = 2000): Operation<void> {
  const deadline = Date.now() + ms

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting')
    }

    yield* sleep(2)
  }
}

/** A Logger line logged in `scope` (the root: no node, tracing never enabled there). */
const logIn = (scope: Scope, msg: string, binding = '@ozaco/db') =>
  within(scope, () => Logger.actions.child({ logger: binding }, () => Logger.actions.warn(msg)))

/** Whether a record emitted in `scope` would go anywhere. */
const canEmitIn = (scope: Scope) => within(scope, () => Trace.actions.canEmit())

/** The recommended root: `DefaultLogger` + `TraceTransport` installed once, before any node. */
function* rootLogger(): Operation<Scope> {
  yield* DefaultLogger.use({ level: LogLevel.info })
  yield* TraceTransport.use()

  return yield* useScope()
}

describe('process logs — a node claims the lines logged outside it', () => {
  it('a transport / db Logger line from a parent scope lands in the node’s exporters with its resource', async () => {
    const sink = memoryExporter()
    const link = createLink()
    let instance = ''

    unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        // infrastructure BEFORE the node, in the root: its loops log where tracing is off
        yield* MemoryTransport.use({ link, prefix: 'shop' })

        yield* scoped(function* () {
          yield* storage()
          yield* createServer({ name: 'shop-node', services: [shop], plugins: [sink.plugin] })
          instance = (yield* useContext(Server)).instance

          // a real transport line: the link drops, the transport's watcher logs it (root scope)
          setStatus(link, 'reconnecting')
          yield* until(() => sink.byBody('transport connection lost').length > 0)
          setStatus(link, 'connected')
          yield* until(() => sink.byBody('transport reconnected').length > 0)

          // a db operational line (`dbLog` shape: the `@ozaco/db` logger binding) from the root
          yield* logIn(root, 'db bus: envelopes lost — replaying the change logs')
        })
      }),
    )

    const lost = sink.byBody('transport connection lost')

    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatchObject({
      severityNumber: 13,
      severityText: 'WARN',
      context: null,
      service: null,
      scope: { name: '@ozaco/transport' },
      attributes: { 'messaging.system': 'memory' },
    })
    expect(lost[0]!.resource).toMatchObject({
      'service.name': 'shop-node',
      'service.namespace': 'shop-node',
      'service.instance.id': instance,
    })

    expect(sink.byBody('transport reconnected')).toHaveLength(1)

    const db = sink.byBody('db bus: envelopes lost — replaying the change logs')

    expect(db).toHaveLength(1)
    expect(db[0]).toMatchObject({ scope: { name: '@ozaco/db' }, severityNumber: 13 })
    expect(db[0]!.resource['service.name']).toBe('shop-node')
  })

  it('std:trace records from outside (recordFailure, emitLog, event) land there too — once each', async () => {
    const sink = memoryExporter()
    const failure = fail('queue.lease', 'a lease expired')

    unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        yield* scoped(function* () {
          yield* storage()
          yield* createServer({ name: 'worker-node', services: [shop], plugins: [sink.plugin] })

          yield* within(root, () => Trace.actions.recordFailure(failure))
          yield* within(root, () => Trace.actions.recordFailure(failure))
          yield* within(root, () =>
            Trace.actions.emitLog({
              body: 'a bootstrap record',
              severityNumber: 9,
              scope: { name: 'boot' },
            }),
          )
          yield* within(root, () => Trace.actions.event('boot.ready', { 'boot.ms': 12 }))
        })
      }),
    )

    expect(sink.byBody('a bootstrap record')).toMatchObject([{ scope: { name: 'boot' } }])
    expect(sink.logs().filter(log => log.eventName === 'boot.ready')).toMatchObject([
      { attributes: { 'boot.ms': 12 }, context: null },
    ])

    const exceptions = sink.logs().filter(log => log.attributes['exception.type'] === 'queue.lease')

    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]).toMatchObject({ eventName: 'exception', severityNumber: 17 })
    expect(exceptions[0]!.resource['service.name']).toBe('worker-node')
  })

  it('a root TraceTransport + logging inside the node: exactly ONE record per line', async () => {
    const sink = memoryExporter()

    const seen = unwrap(
      await run(function* () {
        const root = yield* rootLogger()
        const rootTransport = yield* TraceTransport.context.get()

        return yield* scoped(function* () {
          yield* storage()

          const server = yield* createServer({ services: [shop], plugins: [sink.plugin] })

          // the node saw the root's TraceTransport and did not install its own
          const skipped = (yield* TraceTransport.context.get()) === rootTransport

          yield* server.call(shop, 'hello')
          yield* logIn(root, 'from the root')

          // a second install inside the node REPLACES the inherited one where it is visible:
          // still one record per line, inside and outside
          yield* TraceTransport.use()
          yield* server.call(shop, 'hello')
          yield* logIn(root, 'from the root again')

          return { skipped }
        })
      }),
    )

    expect(seen.skipped).toBe(true)

    const inside = sink.byBody('inside the node')

    expect(inside).toHaveLength(2)

    for (const line of inside) {
      // inside: the node's Trace sink, correlated to the action's span
      expect(line.context?.spanId).toMatch(/^[0-9a-f]{16}$/u)
    }

    expect(sink.byBody('from the root')).toHaveLength(1)
    expect(sink.byBody('from the root again')).toHaveLength(1)
    expect(sink.byBody('from the root')[0]!.context).toBeNull()
  })

  it('stop() gives the claim back; start() takes it again', async () => {
    const sink = memoryExporter()

    const seen = unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        return yield* scoped(function* () {
          yield* storage()

          const server = yield* createServer({ services: [shop], plugins: [sink.plugin] })

          yield* server.start()

          const claimed = yield* canEmitIn(root)

          yield* logIn(root, 'while claimed')

          yield* server.stop()

          const released = yield* canEmitIn(root)

          yield* logIn(root, 'after stop')

          yield* server.start()
          yield* logIn(root, 'after restart')
          yield* server.stop()

          return { claimed, released }
        })
      }),
    )

    expect(seen).toEqual({ claimed: true, released: false })
    expect(sink.bodies()).toContain('while claimed')
    expect(sink.bodies()).toContain('after restart')
    expect(sink.bodies()).not.toContain('after stop')
  })

  it('the node’s scope ending (no stop) gives the claim back too', async () => {
    const sink = memoryExporter()

    const after = unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        yield* scoped(function* () {
          yield* storage()
          yield* createServer({ services: [shop], plugins: [sink.plugin] })
        })

        yield* logIn(root, 'nobody claims this')

        return yield* Trace.actions.canEmit()
      }),
    )

    expect(after).toBe(false)
    expect(sink.bodies()).not.toContain('nobody claims this')
  })

  it('two observing nodes: the first claims; the second takes over when the first stops', async () => {
    const first = memoryExporter()
    const second = memoryExporter()

    unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        yield* scoped(function* () {
          yield* storage()

          const a = yield* createServer({ name: 'a', services: [shop], plugins: [first.plugin] })

          yield* scoped(function* () {
            const b = yield* createServer({
              name: 'b',
              services: [shop],
              plugins: [second.plugin],
            })

            yield* logIn(root, 'to the first')
            yield* a.stop()
            yield* logIn(root, 'to the second')
            yield* b.stop()
            yield* logIn(root, 'to nobody')
          })
        })
      }),
    )

    expect(first.bodies()).toEqual(['to the first'])
    expect(first.logs()[0]!.resource['service.name']).toBe('a')
    expect(second.bodies()).toEqual(['to the second'])
    expect(second.logs()[0]!.resource['service.name']).toBe('b')
  })

  it('no claim: observe.processLogs false, or a node that does not observe', async () => {
    const optedOut = memoryExporter()

    const seen = unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        const off = yield* scoped(function* () {
          yield* storage()
          yield* createServer({
            services: [shop],
            plugins: [optedOut.plugin],
            observe: { processLogs: false },
          })
          yield* logIn(root, 'not claimed')

          return yield* canEmitIn(root)
        })

        const idle = yield* scoped(function* () {
          yield* storage()
          yield* createServer({ services: [shop] })

          return yield* canEmitIn(root)
        })

        return { off, idle }
      }),
    )

    expect(seen).toEqual({ off: false, idle: false })
    expect(optedOut.bodies()).not.toContain('not claimed')
  })
})

/** A plugin whose setup logs `msg` — while the node installing it is still coming up (its tracing
 * is switched on only once every plugin is in); `root` also gets a line logged outside the node. */
const bootLine = (msg: string, root?: { scope: Scope; msg: string }) => {
  installs += 1

  return definePlugin<ServerDef.PluginContext, []>({
    name: `test/boot-line-${installs}`,
    version: '1.0.0',
    description: 'logs while its node comes up',
    *setup() {
      yield* Logger.actions.child({ logger: 'boot' }, () => Logger.actions.warn(msg))

      if (root) {
        yield* logIn(root.scope, root.msg)
      }

      return {}
    },
  }).build()
}

describe('process logs — what a node logs while it comes up is its own', () => {
  it('a line logged inside a node before its tracing is on is never another node’s', async () => {
    const first = memoryExporter()
    const second = memoryExporter()
    let instances = { a: '', b: '' }

    unwrap(
      await run(function* () {
        yield* rootLogger()

        yield* scoped(function* () {
          yield* storage()
          yield* createServer({ name: 'a', services: [shop], plugins: [first.plugin] })

          const a = (yield* useContext(Server)).instance

          // `a` claims the process's records by now: `b`'s boot line fell to it before the fix
          const b = yield* scoped(function* () {
            yield* createServer({
              name: 'b',
              services: [shop],
              plugins: [bootLine('b is coming up'), second.plugin],
            })

            return (yield* useContext(Server)).instance
          })

          instances = { a, b }
        })
      }),
    )

    expect(first.bodies()).not.toContain('b is coming up')

    const line = second.byBody('b is coming up')

    expect(line).toHaveLength(1)
    expect(line[0]).toMatchObject({ severityNumber: 13, scope: { name: 'boot' } })
    expect(line[0]!.resource).toMatchObject({
      'service.name': 'b',
      'service.instance.id': instances.b,
    })
    expect(instances.a).not.toBe(instances.b)
  })

  it('the first node keeps its own boot lines — and the process’s, when it claims them', async () => {
    const sink = memoryExporter()
    const optedOut = memoryExporter()

    unwrap(
      await run(function* () {
        const root = yield* rootLogger()

        yield* scoped(function* () {
          yield* storage()
          yield* createServer({
            name: 'solo',
            services: [shop],
            plugins: [
              bootLine('solo is coming up', { scope: root, msg: 'the process, meanwhile' }),
              sink.plugin,
            ],
          })
        })

        // a node that does not claim the process keeps its own boot lines only
        yield* scoped(function* () {
          yield* storage()
          yield* createServer({
            name: 'private',
            services: [shop],
            observe: { processLogs: false },
            plugins: [
              bootLine('private is coming up', { scope: root, msg: 'not its to claim' }),
              optedOut.plugin,
            ],
          })
        })
      }),
    )

    expect(sink.byBody('solo is coming up')).toHaveLength(1)
    expect(sink.byBody('solo is coming up')[0]!.resource['service.name']).toBe('solo')
    expect(sink.byBody('the process, meanwhile')).toHaveLength(1)

    expect(optedOut.byBody('private is coming up')).toHaveLength(1)
    expect(optedOut.bodies()).not.toContain('not its to claim')
  })

  it('a node that does not observe keeps its lines to itself: the claimant never gets them', async () => {
    const claimant = memoryExporter()

    unwrap(
      await run(function* () {
        yield* rootLogger()

        yield* scoped(function* () {
          yield* storage()
          yield* createServer({ name: 'a', services: [shop], plugins: [claimant.plugin] })

          yield* scoped(function* () {
            const idle = yield* createServer({
              name: 'idle',
              services: [shop],
              plugins: [bootLine('idle is coming up')],
            })

            // after it came up too: its tracing stays off, its lines are not `a`'s
            yield* idle.call(shop, 'hello')
          })
        })
      }),
    )

    expect(claimant.bodies()).not.toContain('idle is coming up')
    expect(claimant.bodies()).not.toContain('inside the node')
  })
})
