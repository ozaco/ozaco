import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { WebIO } from 'std:io/impl/web'

import { originOf } from '../../src/io/internal/crypto/hlc'

const TOKEN = /^[0-9A-HJKMNP-TV-Z]{22}$/u

describe('originOf', () => {
  it('upper-cases a valid 8-char Crockford origin and answers null for anything else', () => {
    expect(originOf('peer0001')).toBe('PEER0001')
    expect(originOf('SHORT')).toBeNull()
    expect(originOf('TOOLONG00')).toBeNull()
    // I, L, O and U are outside the alphabet — rejected, not aliased to 1/0
    expect(originOf('PEERIL00')).toBeNull()
  })
})

describe('hlc', () => {
  it('mints fixed-width, monotonic tokens for one origin (same-ms counter)', async () => {
    const tokens = unwrap(
      await run(function* () {
        yield* BunIO.use()
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
        yield* WebIO.use()
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
        yield* BunIO.use()
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
        yield* BunIO.use()
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

  it('a token at or behind the local floor is accepted (true) and moves nothing', async () => {
    const result = unwrap(
      await run(function* () {
        yield* BunIO.use()
        const ahead = Date.now() + 5000
        yield* IO.actions.observeHlc(encodeFake(ahead, 3, 'REMTE000'))
        const before = yield* IO.actions.decodeHlc(yield* IO.actions.hlc({ origin: 'PEER0003' }))

        // far in the PAST: nothing to adopt, still not drift
        const accepted = yield* IO.actions.observeHlc(encodeFake(ahead - 60_000, 0, 'REMTE000'))
        const after = yield* IO.actions.decodeHlc(yield* IO.actions.hlc({ origin: 'PEER0003' }))

        return { accepted, before, after, ahead }
      }),
    )

    expect(result.accepted).toBe(true)
    expect(result.after.ts).toBeGreaterThanOrEqual(result.ahead)
    expect(result.after.ts).toBeGreaterThanOrEqual(result.before.ts)
  })

  it('rejects remote clocks beyond maxDriftMs without failing', async () => {
    const result = unwrap(
      await run(function* () {
        yield* BunIO.use()
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
        yield* BunIO.use()
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
      badOrigin: 'std:io.hlc-invalid',
      lookAlike: 'std:io.hlc-invalid',
      short: 'std:io.hlc-invalid',
      alphabet: 'std:io.hlc-invalid',
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
