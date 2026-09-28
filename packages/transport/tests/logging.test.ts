/**
 * Operational logging (design §5): the transport tells the std Logger — when one is installed —
 * about connection loss / return / close and about requests it could not answer, under the
 * binding `logger: '@ozaco/transport'`. Without a Logger it is silent, and a Logger that fails
 * never breaks the transport.
 */
import { CodecErrors } from 'std:codec'
import { attempt, run, sleep } from 'std:effect'
import { DefaultLogger, LogLevel } from 'std:logger'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport, TransportErrors } from 'transport:core'
import { createLink, MemoryTransport, setStatus } from 'transport:impl/memory'

import { capture, linesOf, settled } from './capture'

describe('transport — operational logging', () => {
  it('a lost connection is a WARN, its return and the close INFO lines', async () => {
    const link = createLink()
    const sink = capture()

    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* sink.plugin.use()
        yield* MemoryTransport.use({ prefix: 'ops', link })

        setStatus(link, 'reconnecting')
        yield* settled(sink.entries, 1)
        yield* sleep(20)
        setStatus(link, 'connected')
        yield* settled(sink.entries, 2)
        yield* Transport.actions.drain()
        yield* settled(sink.entries, 3)
      }),
    )

    expect(linesOf(sink.entries)).toEqual([
      'WARN transport connection lost',
      'INFO transport reconnected',
      'INFO transport closed',
    ])

    const [lost, back] = sink.entries

    expect(lost?.data).toMatchObject({ 'messaging.system': 'memory', 'ozaco.prefix': 'ops' })

    const downMs = back?.data?.['ozaco.connection.down_ms'] as number

    expect(downMs).toBeGreaterThanOrEqual(15)
  })

  it('a Logger installed after the transport is still heard', async () => {
    const link = createLink()
    const sink = capture()

    unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryTransport.use({ prefix: 'late', link })
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* sink.plugin.use()

        setStatus(link, 'reconnecting')
        yield* settled(sink.entries, 1)
      }),
    )

    expect(linesOf(sink.entries)).toEqual(['WARN transport connection lost'])
  })

  it('without a Logger nothing is logged and nothing fails', async () => {
    const link = createLink()

    const got = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryTransport.use({ prefix: 'quiet', link })

        const sub = yield* Transport.actions.subscribe<string>('ping')

        setStatus(link, 'reconnecting')
        yield* sleep(10)
        setStatus(link, 'connected')
        yield* Transport.actions.publish('ping', 'still here')

        return (yield* sub.next()).value
      }),
    )

    expect(got).toMatchObject({ value: 'still here' })
  })

  it('a Logger that fails never breaks the transport', async () => {
    const link = createLink()
    const sink = capture(true)

    const got = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* sink.plugin.use()
        yield* MemoryTransport.use({ prefix: 'fragile', link })

        const sub = yield* Transport.actions.subscribe<string>('ping')

        setStatus(link, 'reconnecting')
        yield* sleep(10)
        setStatus(link, 'connected')
        yield* sleep(10)
        yield* Transport.actions.publish('ping', 'delivered')

        return (yield* sub.next()).value
      }),
    )

    expect(got).toMatchObject({ value: 'delivered' })
  })

  it('a reply that cannot leave is a WARN carrying why (the caller is left to its timeout)', async () => {
    const link = createLink()
    const sink = capture()

    const outcome = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* DefaultLogger.use({ level: LogLevel.trace })
        yield* sink.plugin.use()
        yield* MemoryTransport.use({ prefix: 'reply', link })

        // a BigInt has no JSON form: the answer fails to encode on the serving side
        yield* Transport.actions.serve('unanswerable', function* () {
          return { n: 1n }
        })

        const failed = yield* attempt(
          Transport.actions.request('unanswerable', {}, { timeoutMs: 100 }),
        )

        yield* settled(sink.entries, 1)

        return { failed }
      }),
    )

    expect(isFailure(outcome.failed)).toBe(true)
    expect((outcome.failed as { error: unknown }).error).toBe(TransportErrors.Timeout)

    expect(linesOf(sink.entries)).toEqual(['WARN transport reply failed'])

    const [line] = sink.entries

    expect(line?.data).toMatchObject({ 'messaging.destination.name': 'unanswerable' })

    // the failure rides the entry — the encoding failure with the codec's own nested in it
    const failure = line?.failures[0]

    expect(failure?.error).toBe(TransportErrors.Encoding)
    expect(failure?.causes.find(isFailure)?.error).toBe(CodecErrors.Encode)
  })
})
