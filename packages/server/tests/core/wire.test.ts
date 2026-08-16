import {
  CoreErrors,
  decodeEnvelope,
  encodeEnvelope,
  fromWireFailure,
  toWireFailure,
} from 'server:core'
import type { Trace, Wire } from 'server:core'
import { attempt } from 'std:effect'
import { install } from 'std:plugin'
import { appendCauses, fail, isFailure } from 'std:result'
import type { Result } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { runScoped } from '../helpers'

const sampleTrace: Trace = {
  requestId: 'r_test',
  origin: 'external',
  serviceId: 'todos@1#abc',
  actionId: 'a_1',
  lane: [{ service: 'todos', action: 'get', actionId: 'a_1', transport: 'internal', ts: 1 }],
}

describe('wire', () => {
  it('failure → wire → failure keeps tag, message and the whole cause chain', () => {
    const original = fail('todos.not-found', 'todo "42" not found') as Result.Failure<string>

    appendCauses(original, 'action:get(a_1) svc:todos@1#abc req:r_1 lane:gw>todos')
    appendCauses(original, 'transport:nats dispatch cid:c_9')

    const wire = toWireFailure(original, { status: 404, meta: { 'x-a': '1' } })

    expect(wire.error).toBe('todos.not-found')
    expect(wire.status).toBe(404)
    expect(wire.meta).toEqual({ 'x-a': '1' })
    expect(wire.causes).toHaveLength(2)
    expect(wire.halted).toBeUndefined()

    const restored = fromWireFailure(wire)

    expect(restored.error).toBe('todos.not-found')
    expect(restored.message).toBe('todo "42" not found')
    expect([...restored.causes]).toEqual([...wire.causes])
  })

  it('halted failures are flagged on the wire', () => {
    const halted = fail('halted', 'scope closed') as Result.Failure<string>

    expect(toWireFailure(halted).halted).toBe(true)
  })

  it('envelopes round-trip through the routed codec', async () => {
    const envelope: Wire.Envelope = {
      k: 'dispatch',
      v: 1,
      cid: 'c_1',
      service: 'todos',
      action: 'get',
      trace: sampleTrace,
      params: { id: '42' },
      meta: { authorization: 'Bearer t' },
      idempotencyKey: 'op-1',
    }

    const decoded = await runScoped(function* () {
      yield* install(JsonCodec)

      const bytes = yield* encodeEnvelope(envelope)

      return yield* decodeEnvelope(bytes)
    })

    expect(decoded).toEqual(envelope)
  })

  it('malformed envelopes fail loudly', async () => {
    const outcome = await runScoped(function* () {
      yield* install(JsonCodec)

      const notAnEnvelope = yield* encodeEnvelope({ nope: true } as never)
      const malformed = yield* attempt(() => decodeEnvelope(notAnEnvelope))
      const garbage = yield* attempt(() => decodeEnvelope(new Uint8Array([0x7b, 0x22])))

      return { malformed, garbage }
    })

    expect(isFailure(outcome.malformed) && outcome.malformed.error === CoreErrors.BadRequest).toBe(
      true,
    )
    expect(isFailure(outcome.garbage)).toBe(true)
  })
})
