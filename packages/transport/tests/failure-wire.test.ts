/**
 * Failures on the wire (design §6.3): a responder's failure crosses the package plane (and a
 * lane's fail frame) as `{ error, message, causes, origin }` — JsonCodec carrying its nested
 * failures as tag, message and causes (a fold's `raw` stays home) — and comes back as a Failure
 * with a `remote: <operation> @ <service> span <id8>` cause naming where it was answered, then
 * the labels std's plugin runtime appends on the caller's side as the failure leaves `request`
 * (`request`, `transport-memory@<version>`, `dispatch`, `transport@<version>`). A failure the
 * answering side already recorded is marked recorded (remotely) in that trace, so the caller
 * never records it a second time. An older peer's wire (the Failure itself,
 * `{ error, message, causes, _d }`) still decodes, and an older peer still reads ours.
 */
import type { Flow, Operation } from 'std:effect'
import { attempt, fork, run } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, formatFailure, isFailure, ResultErrors, unwrap } from 'std:result'
import type { TraceDef } from 'std:trace'
import { enableTracing, extract, isRecorded, span, Tracer, traceparentOf } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { HEADERS, Transport, TransportErrors } from 'transport:core'
import { createLink, MemoryTransport } from 'transport:impl/memory'

import pkg from '../package.json'

const link = createLink()

/** The labels std's plugin runtime appends, inner hop first, to a failure leaving
 * `Transport.actions.request`: the memory impl's action, then the protocol's dispatch. */
const REQUEST_LABELS = [
  'request',
  `transport-memory@${pkg.version}`,
  'dispatch',
  `transport@${pkg.version}`,
]

let tracers = 0

/** An in-memory Tracer: every exported span and emitted log record lands in the arrays. */
const memoryTracer = () => {
  tracers += 1
  const spans: TraceDef.SpanData[] = []
  const logs: TraceDef.LogData[] = []

  const plugin = Tracer.implement({
    name: `test/transport-tracer-${tracers}`,
    version: '1.0.0',
    *setup() {
      yield* enableTracing()
      return {}
    },
  }).build({
    *export(data: TraceDef.SpanData) {
      spans.push(data)
    },
    *emit(log: TraceDef.LogData) {
      logs.push(log)
    },
  })

  const named = (name: string): TraceDef.SpanData => {
    const found = spans.filter(data => data.name === name)
    expect(found.length).toBe(1)
    return found[0]!
  }

  const exceptions = (): TraceDef.LogData[] =>
    logs.filter(log => log.attributes['exception.type'] !== undefined)

  return { plugin, spans, logs, named, exceptions }
}

function* install(): Operation<void> {
  yield* BunIO.use()
  yield* MemoryTransport.use({ prefix: 'wire', link })
}

const unique = (name: string): string => `${name}.${crypto.randomUUID().slice(0, 8)}`

/** The failure a request to `topic` comes back with. */
function* failureOf(topic: string, args: unknown = {}): Operation<Result.Failure<unknown>> {
  const outcome = yield* attempt(Transport.actions.request(topic, args, { timeoutMs: 2000 }))
  expect(isFailure(outcome)).toBe(true)
  return outcome as Result.Failure<unknown>
}

/** A 3-level chain: `todo.kaput` ← `db.query` ← the fold of a thrown TypeError. */
const brokenChain = () => {
  const thrown = new TypeError('cannot read properties of undefined (reading "id")')
  const query = fail('db.query', 'select failed', 'table=todos', asFailure(thrown))
  const outer = fail('todo.kaput', 'cannot load the todo', 'id=7', query)

  return { thrown, outer }
}

/** The failures `failure` nests, in order. */
const nestedOf = (failure: Result.Failure<unknown>): Result.Failure<unknown>[] =>
  failure.causes.filter(cause => typeof cause !== 'string')

/** The string causes of `failure`, in order. */
const textsOf = (failure: Result.Failure<unknown>): string[] =>
  failure.causes.filter(cause => typeof cause === 'string')

describe('transport — failures on the wire', () => {
  it('a 3-level chain ending in a fold survives the round trip', async () => {
    const { thrown, outer } = brokenChain()

    const failure = unwrap(
      await run(function* () {
        yield* install()
        const topic = unique('rpc.chain')
        yield* Transport.actions.serve(topic, function* () {
          return yield* outer
        })
        const got = yield* failureOf(topic)
        return { got, topic }
      }),
    )

    const { got, topic } = failure
    // the outer failure keeps its tag / message / causes in order, then where it was answered,
    // then the caller's runtime labels
    expect(got.error).toBe('todo.kaput')
    expect(got.message).toBe('cannot load the todo')
    expect(got.causes).toHaveLength(3 + REQUEST_LABELS.length)
    expect(got.causes[0]).toBe('id=7')
    expect(got.causes[2]).toBe(`remote: ${topic}`)
    expect(got.causes.slice(3)).toEqual(REQUEST_LABELS)

    // …and its nested failures came back as real Failures
    const [query] = nestedOf(got)
    expect(isFailure(query)).toBe(true)
    expect(query?.error).toBe('db.query')
    expect(query?.message).toBe('select failed')
    expect(textsOf(query!)).toEqual(['table=todos'])

    // the fold came back as its tag and message — the thrown Error (`raw`) stayed home
    const [fold] = nestedOf(query!)
    expect(fold?.error).toBe(ResultErrors.Unknown)
    expect(fold?.message).toBe(`TypeError: ${thrown.message}`)
    expect(fold?.causes).toEqual([])
    expect('raw' in fold!).toBe(false)

    const rendered = formatFailure(got, { chain: true })
    expect(rendered).toContain(`    at remote: ${topic}`)
    expect(rendered).toContain('Caused by: db.query: select failed')
    expect(rendered).toContain(`Caused by: std:result.unknown: TypeError: ${thrown.message}`)
    // no stack is rendered, none crossed the wire
    expect(rendered).not.toContain('failure-wire.test.ts')
  })

  it('a thrown Error (not a Failure) crosses as its fold: std:result.unknown and its message, no raw', async () => {
    const thrown = new RangeError('offset out of range')

    const { got, topic } = unwrap(
      await run(function* () {
        yield* install()
        const served = unique('rpc.throw')
        yield* Transport.actions.serve(served, function* () {
          throw thrown
        })
        return { got: yield* failureOf(served), topic: served }
      }),
    )

    expect(got.error).toBe(ResultErrors.Unknown)
    expect(got.message).toBe(`RangeError: ${thrown.message}`)
    // one level: the fold carries no failure of its own, only where it was answered and the
    // caller's runtime labels
    expect(got.causes).toEqual([`remote: ${topic}`, ...REQUEST_LABELS])
    // the thrown Error is the answering side's `raw` — it never crosses the wire
    expect('raw' in got).toBe(false)

    const rendered = formatFailure(got, { chain: true })
    expect(rendered).toStartWith('std:result.unknown: RangeError: offset out of range')
    expect(rendered).not.toContain('Caused by:')
  })

  it('a lane fail frame carries the chain too', async () => {
    const { outer } = brokenChain()

    const { close } = unwrap(
      await run(function* () {
        yield* install()
        const topic = unique('lane.chain')
        const failing: Flow<number, void> = {
          *[Symbol.iterator]() {
            return {
              *next() {
                return yield* outer
              },
            }
          },
        }
        const consumer = yield* fork(function* () {
          const lane = yield* Transport.actions.flow<number, void>(topic)
          const step = yield* lane.next()
          return step.done ? step.value : undefined
        })
        yield* attempt(Transport.actions.pipe(topic, failing))
        return { close: yield* consumer }
      }),
    )

    expect(isFailure(close)).toBe(true)
    const failure = close as Result.Failure<unknown>
    expect(failure.error).toBe('todo.kaput')
    // a lane frame names no origin: the causes are the producer's own
    expect(textsOf(failure)).toEqual(['id=7'])
    const [query] = nestedOf(failure)
    expect(query?.error).toBe('db.query')
    expect(nestedOf(query!)[0]?.error).toBe(ResultErrors.Unknown)
    expect(nestedOf(query!)[0]?.message).toStartWith('TypeError: ')
  })

  it('an older peer (the Failure itself, `{ error, message, causes, _d }`) still decodes', async () => {
    const got = unwrap(
      await run(function* () {
        yield* install()
        const tagged = unique('rpc.legacy')
        const thrown = unique('rpc.legacy.thrown')

        // what an old node's encodeFailure put on the wire: the Failure itself, JSON-encoded
        const legacy = (topic: string, wire: Record<string, unknown>) =>
          fork(function* () {
            const requests = yield* Transport.actions.subscribe(topic, { transient: true })
            const step = yield* requests.next()
            if (step.done) {
              return
            }
            const replyTo = step.value.headers[HEADERS.reply] as string
            yield* Transport.actions.publish(replyTo, wire, {
              headers: { [HEADERS.result]: 'fail' },
              transient: true,
            })
          })

        yield* legacy(tagged, {
          error: 'math.divide-by-zero',
          message: 'b must not be 0',
          causes: ['a=1'],
          _d: 1_700_000_000_000,
        })
        // an Error `error` JSON-encoded to `{}` on the old wire: kept as it came
        yield* legacy(thrown, { error: {}, message: 'boom', causes: [], _d: 1 })

        return { tagged: yield* failureOf(tagged), thrown: yield* failureOf(thrown) }
      }),
    )

    expect(got.tagged.error).toBe('math.divide-by-zero')
    expect(got.tagged.message).toBe('b must not be 0')
    // no origin on that wire: no `remote:` cause, only the caller's runtime labels
    expect(got.tagged.causes).toEqual(['a=1', ...REQUEST_LABELS])

    expect(got.thrown.error).toEqual({})
    expect(got.thrown.message).toBe('boom')
    expect(got.thrown.causes).toEqual(REQUEST_LABELS)
  })

  it('an older peer reads our reply as `{ error, message, causes }`', async () => {
    const wire = unwrap(
      await run(function* () {
        yield* install()
        const topic = unique('rpc.forward')
        yield* Transport.actions.serve(topic, function* () {
          return yield* fail('math.divide-by-zero', 'b must not be 0', 'a=1')
        })
        // what an old node's request did: publish with a reply topic, read the reply's value
        const inbox = unique('old.inbox')
        const replies = yield* Transport.actions.subscribe<Record<string, unknown>>(inbox, {
          transient: true,
        })
        yield* Transport.actions.publish(
          topic,
          {},
          {
            headers: { [HEADERS.reply]: inbox },
            transient: true,
          },
        )
        const step = yield* replies.next()
        return { value: step.done ? undefined : step.value.value, topic }
      }),
    )

    expect(wire.value).toMatchObject({
      error: 'math.divide-by-zero',
      message: 'b must not be 0',
      causes: ['a=1'],
      origin: { operation: wire.topic },
    })
  })

  it('a malformed failure reply fails as transport.encoding; junk causes and origin fields are dropped', async () => {
    const got = unwrap(
      await run(function* () {
        yield* install()
        const junk = unique('rpc.junk')
        const odd = unique('rpc.odd')

        const reply = (topic: string, wire: unknown) =>
          fork(function* () {
            const requests = yield* Transport.actions.subscribe(topic, { transient: true })
            const step = yield* requests.next()
            if (step.done) {
              return
            }
            yield* Transport.actions.publish(step.value.headers[HEADERS.reply] as string, wire, {
              headers: { [HEADERS.result]: 'fail' },
              transient: true,
            })
          })

        yield* reply(junk, 'boom')
        yield* reply(odd, {
          error: 'odd.tag',
          message: 7,
          causes: ['kept', 42, { a: 1 }, null],
          origin: { operation: 'odd.op', service: 9, spanId: ['x'], recorded: 'yes' },
        })

        return { junk: yield* failureOf(junk), odd: yield* failureOf(odd) }
      }),
    )

    expect(got.junk.error).toBe(TransportErrors.Encoding)
    expect(got.odd.error).toBe('odd.tag')
    expect(got.odd.message).toBe('')
    expect(got.odd.causes).toEqual(['kept', 'remote: odd.op', ...REQUEST_LABELS])
  })

  it('the request carries the caller trace context; a caller-set traceparent wins', async () => {
    const tracer = memoryTracer()
    const own = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

    const seen = unwrap(
      await run(function* () {
        yield* tracer.plugin.use()
        yield* install()
        const topic = unique('rpc.headers')
        yield* Transport.actions.serve<unknown, Record<string, string | undefined>>(
          topic,
          function* (_args, message) {
            return {
              traceparent: message.headers.traceparent,
              tracestate: message.headers.tracestate,
            }
          },
        )
        const inside = yield* span('caller', { kind: 'client' }, function* (handle) {
          const echoed = yield* Transport.actions.request<Record<string, string | undefined>>(
            topic,
            {},
          )
          return { echoed, context: handle.context }
        })
        const pinned = yield* span('pinned', function* () {
          return yield* Transport.actions.request<Record<string, string | undefined>>(
            topic,
            {},
            { headers: { traceparent: own } },
          )
        })
        const outside = yield* Transport.actions.request<Record<string, string | undefined>>(
          topic,
          {},
        )
        return { inside, pinned, outside }
      }),
    )

    const { context, echoed } = seen.inside
    expect(echoed.traceparent).toBe(traceparentOf(context))
    expect(seen.pinned.traceparent).toBe(own)
    // no span, no context: nothing rides along
    expect(seen.outside.traceparent).toBeUndefined()
  })

  it('a failure recorded by the answering side is recorded ONCE: the caller only marks it', async () => {
    const tracer = memoryTracer()
    const { outer } = brokenChain()

    const { got } = unwrap(
      await run(function* () {
        yield* tracer.plugin.use()
        yield* install()
        const topic = unique('rpc.recorded')
        // the owner continues the caller's trace (as a server carrier does) and fails in a span
        yield* Transport.actions.serve(topic, function* (_args, message) {
          const parent = extract(name => message.headers[name])
          return yield* span('todos.load', { kind: 'server', parent }, function* () {
            return yield* outer
          })
        })
        return {
          got: yield* attempt(
            span('todos.load call', { kind: 'client' }, () => Transport.actions.request(topic, {})),
          ),
        }
      }),
    )

    expect(isFailure(got)).toBe(true)
    const failure = got as Result.Failure<unknown>

    // exactly one exception record in the whole trace — the owner's
    const exceptions = tracer.exceptions()
    expect(exceptions).toHaveLength(1)
    const owner = tracer.named('todos.load')
    // the decoded failure is known recorded in that trace (the registry, no field on it)
    expect(isRecorded(failure, owner.context.traceId)).toBe(true)
    expect(exceptions[0]?.context?.spanId).toBe(owner.context.spanId)
    expect(owner.events.filter(event => event.name === 'exception')).toHaveLength(1)

    // the caller's span: status + error.type + the remote marker, no exception of its own
    const caller = tracer.named('todos.load call')
    expect(caller.context.traceId).toBe(owner.context.traceId)
    expect(owner.parent?.spanId).toBe(caller.context.spanId)
    expect(caller.status.code).toBe('error')
    expect(caller.attributes['error.type']).toBe('todo.kaput')
    expect(caller.attributes['ozaco.failure.remote']).toBe(true)
    expect(caller.events.filter(event => event.name === 'exception')).toHaveLength(0)
  })

  it('a failure recorded in ANOTHER trace (a caller-pinned traceparent) is recorded by the caller too', async () => {
    const tracer = memoryTracer()
    const { outer } = brokenChain()
    const own = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

    const { got } = unwrap(
      await run(function* () {
        yield* tracer.plugin.use()
        yield* install()
        const topic = unique('rpc.pinned')
        yield* Transport.actions.serve(topic, function* (_args, message) {
          const parent = extract(name => message.headers[name])
          return yield* span('todos.load', { kind: 'server', parent }, function* () {
            return yield* outer
          })
        })
        return {
          got: yield* attempt(
            span('call', { kind: 'client' }, () =>
              Transport.actions.request(topic, {}, { headers: { traceparent: own } }),
            ),
          ),
        }
      }),
    )

    expect(isFailure(got)).toBe(true)
    const failure = got as Result.Failure<unknown>
    const owner = tracer.named('todos.load')
    const caller = tracer.named('call')
    expect(owner.context.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(caller.context.traceId).not.toBe(owner.context.traceId)

    // marked recorded in the trace the answering side named — not in the caller's
    expect(isRecorded(failure, owner.context.traceId)).toBe(true)
    expect(caller.attributes['ozaco.failure.remote']).toBeUndefined()
    // one exception per trace: the owner's, and the caller's own
    const spans = tracer.exceptions().map(log => log.context?.spanId)
    expect(spans.toSorted()).toEqual([owner.context.spanId, caller.context.spanId].toSorted())
  })

  it('a failure the answering side did NOT record is recorded by the caller, chain included', async () => {
    const tracer = memoryTracer()
    const { outer } = brokenChain()

    const { got } = unwrap(
      await run(function* () {
        yield* tracer.plugin.use()
        yield* install()
        const topic = unique('rpc.unrecorded')
        // a responder without a span of its own: nothing records the failure over there
        yield* Transport.actions.serve(topic, function* () {
          return yield* outer
        })
        return {
          got: yield* attempt(
            span('call', { kind: 'client' }, () => Transport.actions.request(topic, {})),
          ),
        }
      }),
    )

    expect(isFailure(got)).toBe(true)

    const exceptions = tracer.exceptions()
    expect(exceptions).toHaveLength(1)
    const caller = tracer.named('call')
    expect(exceptions[0]?.context?.spanId).toBe(caller.context.spanId)
    expect(caller.attributes['ozaco.failure.remote']).toBeUndefined()
    expect(exceptions[0]?.attributes['ozaco.failure.chain']).toHaveLength(3)
    expect(exceptions[0]?.body).toContain('Caused by: std:result.unknown: TypeError')
  })

  it('serve({ origin }) names the answering side on the caller failure', async () => {
    const { got } = unwrap(
      await run(function* () {
        yield* install()
        const topic = unique('rpc.origin')
        yield* Transport.actions.serve<{ action: string }, never>(
          topic,
          function* () {
            return yield* fail('todo.missing', 'no such todo')
          },
          {
            origin: (_failure, request) => ({
              service: 'api',
              operation: `todos.${request.value.action}`,
              spanId: '00f067aa0ba902b7',
            }),
          },
        )
        return { got: yield* failureOf(topic, { action: 'load' }) }
      }),
    )

    expect(got.causes).toEqual(['remote: todos.load @ api span 00f067aa', ...REQUEST_LABELS])
    expect(formatFailure(got)).toBe(
      `todo.missing: no such todo: remote: todos.load @ api span 00f067aa > ${REQUEST_LABELS.join(' > ')}`,
    )
  })

  it('a failure re-raised from a further hop names every hop, the farthest first', async () => {
    const far = unique('rpc.far')
    const near = unique('rpc.near')
    const { got } = unwrap(
      await run(function* () {
        yield* install()
        yield* Transport.actions.serve(
          far,
          function* () {
            return yield* fail('reports.down', 'reports are offline')
          },
          { origin: () => ({ service: 'reports' }) },
        )
        // the middle hop re-raises the decoded failure unchanged
        yield* Transport.actions.serve(near, function* () {
          return yield* Transport.actions.request(far, {})
        })
        return { got: yield* failureOf(near) }
      }),
    )

    expect(got.error).toBe('reports.down')
    // each hop's `request` adds where it was answered, then its own runtime labels (the middle
    // hop's travel on with the failure)
    expect(got.causes).toEqual([
      `remote: ${far} @ reports`,
      ...REQUEST_LABELS,
      `remote: ${near}`,
      ...REQUEST_LABELS,
    ])
  })
})
