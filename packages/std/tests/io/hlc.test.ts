import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { WebIO } from 'std:io/impl/web'

const TOKEN = /^[0-9A-HJKMNP-TV-Z]{22}$/u

describe('hlc', () => {
  it('mints fixed-width, monotonic tokens for one origin (same-ms counter)', async () => {
    const tokens = unwrap(
      await run(function* () {
        yield* install(BunIO)
        const out: string[] = []
        for (let i = 0; i < 1000; i++) {
          out.push(yield* IO.actions.hlc({ origin: 'NDEA0001' }))
        }
        return out
      }),
    )
    for (const token of tokens) {
      expect(token).toMatch(TOKEN)
    }
    expect(tokens.toSorted()).toEqual(tokens)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('round-trips through decodeHlc and carries the origin', async () => {
    const result = unwrap(
      await run(function* () {
        yield* install(WebIO)
        const before = Date.now()
        const token = yield* IO.actions.hlc({ origin: 'ndeb0002' }) // lowercase accepted, upper-cased
        const parts = yield* IO.actions.decodeHlc(token)
        return { before, token, parts }
      }),
    )
    expect(result.token.endsWith('NDEB0002')).toBe(true)
    expect(result.parts.origin).toBe('NDEB0002')
    expect(result.parts.ts).toBeGreaterThanOrEqual(result.before)
    expect(result.parts.counter).toBeGreaterThanOrEqual(0)
  })

  it('keeps independent counters per origin in one process', async () => {
    const result = unwrap(
      await run(function* () {
        yield* install(BunIO)
        const a1 = yield* IO.actions.decodeHlc(yield* IO.actions.hlc({ origin: 'AAAAAAAA' }))
        const b1 = yield* IO.actions.decodeHlc(yield* IO.actions.hlc({ origin: 'BBBBBBBB' }))
        const a2 = yield* IO.actions.decodeHlc(yield* IO.actions.hlc({ origin: 'AAAAAAAA' }))
        return { a1, b1, a2 }
      }),
    )
    // B's mint must not advance A's counter: A's second token is A's first + 1 (same ms) or a
    // later ms with counter 0 — never a jump caused by B
    if (result.a2.ts === result.a1.ts) {
      expect(result.a2.counter).toBe(result.a1.counter + 1)
    } else {
      expect(result.a2.counter).toBe(0)
    }
  })

  it('observeHlc pulls the clock forward so later tokens sort after the remote one', async () => {
    const result = unwrap(
      await run(function* () {
        yield* install(BunIO)
        // a peer whose clock is 5s ahead (within the drift bound)
        const ahead = Date.now() + 5000
        const remote = encodeFake(ahead, 7, 'REMTE000')
        const adopted = yield* IO.actions.observeHlc(remote)
        const local = yield* IO.actions.hlc({ origin: 'PEER0001' })
        const parts = yield* IO.actions.decodeHlc(local)
        return { adopted, remote, local, parts, ahead }
      }),
    )
    expect(result.adopted).toBe(true)
    expect(result.local > result.remote).toBe(true)
    expect(result.parts.ts).toBeGreaterThanOrEqual(result.ahead)
  })

  it('rejects remote clocks beyond maxDriftMs without failing', async () => {
    const result = unwrap(
      await run(function* () {
        yield* install(BunIO)
        const farFuture = encodeFake(Date.now() + 10 * 60_000, 0, 'DRFT0000')
        const adopted = yield* IO.actions.observeHlc(farFuture, { maxDriftMs: 60_000 })
        const local = yield* IO.actions.decodeHlc(yield* IO.actions.hlc({ origin: 'PEER0002' }))
        return { adopted, local, now: Date.now() }
      }),
    )
    expect(result.adopted).toBe(false)
    // the local clock stayed near wall time
    expect(result.local.ts - result.now).toBeLessThan(60_000)
  })

  it('fails hlc-invalid on bad origins and malformed tokens', async () => {
    const result = unwrap(
      await run(function* () {
        yield* install(BunIO)
        const badOrigin = yield* attempt(IO.actions.hlc({ origin: 'node-a' }))
        // I/L/O/U are not in the alphabet and are NOT aliased for origins (identity must be exact)
        const lookAlike = yield* attempt(IO.actions.hlc({ origin: 'NODEA000' }))
        const short = yield* attempt(IO.actions.decodeHlc('01J6'))
        const alphabet = yield* attempt(IO.actions.decodeHlc('U'.repeat(22)))
        return {
          badOrigin: isFailure(badOrigin) ? badOrigin.error : 'ok',
          lookAlike: isFailure(lookAlike) ? lookAlike.error : 'ok',
          short: isFailure(short) ? short.error : 'ok',
          alphabet: isFailure(alphabet) ? alphabet.error : 'ok',
        }
      }),
    )
    expect(result).toEqual({
      badOrigin: 'hlc-invalid',
      lookAlike: 'hlc-invalid',
      short: 'hlc-invalid',
      alphabet: 'hlc-invalid',
    })
  })
})

/** Build a token by hand (the encoder is private): used to simulate a remote peer's token. */
const encodeFake = (ts: number, counter: number, origin: string): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const encode = (value: number, length: number): string => {
    let out = ''
    let rest = value
    for (let i = 0; i < length; i++) {
      out = alphabet[rest % 32]! + out
      rest = Math.floor(rest / 32)
    }
    return out
  }
  return encode(ts, 10) + encode(counter, 4) + (origin as AnyType)
}
