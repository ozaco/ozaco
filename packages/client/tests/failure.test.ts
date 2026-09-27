/**
 * A failed reply decoded through JsonCodec — the wire's failure path: the nested failures a server
 * exposes come back as real Failures (tag, message, causes — a `raw` stays home), an ozaco reply
 * is a REMOTE failure named by a `remote: <operation> @ <service> span <id8>` cause (a bare proxy
 * reply is not), one the server recorded in the caller's trace is marked recorded there, and the
 * decode works without a codec in the caller's scope (codegen's `pull`) without leaving one
 * behind.
 */
import { createClient, failureOf, wireFailureOf } from 'client:core'
import { attempt, run } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure, ResultErrors, unwrap } from 'std:result'
import { isRecorded } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

const URL_BASE = 'http://failure.test'
const TRACE = 'ab'.repeat(16)
const OTHER_TRACE = 'cd'.repeat(16)
const SPAN = '1234567890abcdef'

/** `value` as JsonCodec writes it (a Failure tagged, through nested causes). */
const encoded = async (value: unknown): Promise<string> =>
  unwrap(
    await run(function* () {
      yield* JsonCodec.use()
      return yield* JsonCodec.actions.stringify(value)
    }),
  )

/** The failure a server wraps: a domain failure over the fold of a platform error (its `raw`). */
const storageFailure = () =>
  fail(
    'storage.full',
    'cannot write the report',
    'disk:reports',
    asFailure(Object.assign(new RangeError('no space left on device'), { code: 'ENOSPC' })),
  )

/** An ozaco failure reply: the `{ error }` envelope (through JsonCodec) + `oz-error`. */
const ozacoReply = async (
  options: { readonly causes?: readonly unknown[]; readonly traceId?: string } = {},
): Promise<() => Response> => {
  const body = await encoded({
    error: {
      error: 'jobs.failed',
      message: 'job failed',
      causes: options.causes ?? ['job:1', storageFailure()],
      status: 500,
      requestId: 'r-9',
      traceId: options.traceId ?? TRACE,
    },
  })

  return () =>
    new Response(body, {
      status: 500,
      headers: {
        'content-type': 'application/json',
        'oz-error': 'jobs.failed',
        'x-request-id': 'r-9',
        traceresponse: `00-${TRACE}-${SPAN}-01`,
      },
    })
}

/** The manifest fetch failing with `reply` — decoded like any action reply (boxed: a Failure an
 * op returns would fail the run). */
const manifestFailure = async (reply: () => Response): Promise<Result.Failure<unknown>> =>
  unwrap(
    await run(function* () {
      const client = yield* createClient({
        url: URL_BASE,
        fetch: (() => Promise.resolve(reply())) as unknown as typeof fetch,
      })

      return { failed: (yield* attempt(client.$manifest())) as Result.Failure<unknown> }
    }),
  ).failed

describe('failure decode — the JsonCodec path', () => {
  it('nested failures in the causes come back as real Failures, the fold without its raw', async () => {
    const failed = await manifestFailure(await ozacoReply())

    expect(isFailure(failed)).toBe(true)
    expect(failed.error).toBe('jobs.failed')
    expect(failed.message).toContain('job failed')
    expect(failed.causes).toHaveLength(5)
    expect(failed.causes[0]).toBe('job:1')

    // the wrapped failure: a real one (iterable, `isFailure`), its own causes kept in order
    const storage = failed.causes[1] as Result.Failure<unknown>
    expect(isFailure(storage)).toBe(true)
    expect(storage.error).toBe('storage.full')
    expect(storage.message).toBe('cannot write the report')
    expect(storage.causes[0]).toBe('disk:reports')

    // … over the platform error's fold: its tag and text travel, the platform error (`raw`) never
    const platform = storage.causes[1] as Result.Failure<unknown>
    expect(isFailure(platform)).toBe(true)
    expect(platform.error).toBe(ResultErrors.Unknown)
    expect(platform.message).toBe('RangeError: no space left on device (ENOSPC)')
    expect(platform.causes).toEqual([])
    expect('raw' in platform).toBe(false)

    // where it came from (the answering span from `traceresponse`), then the breadcrumbs LAST
    expect(failed.causes.slice(2)).toEqual([
      `remote: manifest span ${SPAN.slice(0, 8)}`,
      'req:r-9',
      'status:500',
    ])
  })

  it('a traceresponse outside the trace the envelope names is not the answering span', async () => {
    const failed = await manifestFailure(await ozacoReply({ causes: [], traceId: OTHER_TRACE }))

    expect(failed.causes).toEqual(['remote: manifest', 'req:r-9', 'status:500'])
  })

  it('a bare proxy reply (no envelope, no oz-error) is the client`s own verdict: not remote', async () => {
    const failed = await manifestFailure(() => new Response('bad gateway', { status: 502 }))

    expect(failed.error).toBe('http.502')
    expect(failed.causes).toEqual(['status:502'])
  })

  it('outside a client: JsonCodec decodes it in a scope of its own — none is left behind', async () => {
    const reply = await ozacoReply({ causes: [storageFailure()] })

    const { failed, leaked } = unwrap(
      await run(function* () {
        const outcome = yield* attempt(() =>
          failureOf(reply(), 'r-9', {
            remote: { operation: 'jobs.status', service: 'jobs', recordedIn: TRACE },
          }),
        )

        return {
          failed: outcome as Result.Failure<unknown>,
          leaked: (yield* JsonCodec.context.get()) !== undefined,
        }
      }),
    )

    expect(leaked).toBe(false)
    expect(isFailure(failed.causes[0])).toBe(true)
    expect((failed.causes[0] as Result.Failure<unknown>).error).toBe('storage.full')
    expect(failed.causes.slice(1)).toEqual([
      `remote: jobs.status @ jobs span ${SPAN.slice(0, 8)}`,
      'req:r-9',
      'status:500',
    ])
    // the server recorded it in the caller's trace: marked recorded there (a remote one)
    expect(isRecorded(failed, TRACE)).toBe(true)
    expect(isRecorded(failed, OTHER_TRACE)).toBe(false)
  })

  it('wireFailureOf renders a nested failure cause as its one-line form', () => {
    const rendered = wireFailureOf(
      fail('jobs.failed', 'job failed', fail('storage.full', 'disk full'), 'req:r-1', 'status:503'),
    )

    expect(rendered.causes).toEqual(['storage.full: disk full', 'req:r-1', 'status:503'])
    expect(rendered.status).toBe(503)
    expect(rendered.requestId).toBe('r-1')
  })
})
