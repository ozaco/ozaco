import { attempt, run } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

// `IO.actions.password`: scrypt on both runtimes (one digest, verifiable on either), argon2id /
// bcrypt on Bun's native hasher only, `verify` reading the algorithm from the digest's prefix.

const errorOf = (outcome: unknown): string =>
  isFailure(outcome) ? (outcome.error as string) : 'no-failure'

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s password — scrypt', (_label, impl) => {
  it('hashes into a PHC string and verifies only the password that made it', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const { password } = IO.actions
      const digest = yield* password.hash('correct horse', { algorithm: 'scrypt', cost: 12 })
      const again = yield* password.hash('correct horse', { algorithm: 'scrypt', cost: 12 })

      return {
        prefix: digest.slice(0, '$scrypt$ln=12,r=8,p=1$'.length),
        salted: digest !== again,
        ok: yield* password.verify('correct horse', digest),
        wrong: yield* password.verify('wrong horse', digest),
        tampered: yield* password.verify('correct horse', `${digest.slice(0, -2)}AA`),
        garbage: yield* password.verify('correct horse', 'not a digest'),
        empty: yield* password.verify('correct horse', ''),
        tooCostly: yield* password.verify(
          'correct horse',
          '$scrypt$ln=30,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ),
      }
    })

    expect(unwrap(outcome)).toEqual({
      prefix: '$scrypt$ln=12,r=8,p=1$',
      salted: true,
      ok: true,
      wrong: false,
      tampered: false,
      garbage: false,
      empty: false,
      tooCostly: false,
    })
  })

  it('reject answers false after real work', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const started = performance.now()
      const first = yield* IO.actions.password.reject('whatever')
      const second = yield* IO.actions.password.reject('whatever')

      return { first, second, worked: performance.now() - started > 0 }
    })

    expect(unwrap(outcome)).toEqual({ first: false, second: false, worked: true })
  })
})

// a scrypt digest made on one runtime verifies on the other: same node:crypto underneath
it('a scrypt digest crosses runtimes', async () => {
  const digest = unwrap(
    await run(function* () {
      yield* BunIO.use()

      return yield* IO.actions.password.hash('shared', { algorithm: 'scrypt', cost: 12 })
    }),
  )

  const verified = unwrap(
    await run(function* () {
      yield* NodeIO.use()

      return yield* IO.actions.password.verify('shared', digest)
    }),
  )

  expect(verified).toBe(true)
})

describe('BunIO password — native argon2id and bcrypt', () => {
  it('argon2id is the default; bcrypt by name; a native digest the hasher cannot read is false', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const { password } = IO.actions
      const argon = yield* password.hash('pw', { memoryCost: 4096, timeCost: 2 })
      const bcrypt = yield* password.hash('pw', { algorithm: 'bcrypt', cost: 4 })

      return {
        argonPrefix: argon.startsWith('$argon2id$'),
        bcryptPrefix: bcrypt.startsWith('$2b$04$'),
        argonOk: yield* password.verify('pw', argon),
        argonWrong: yield* password.verify('nope', argon),
        bcryptOk: yield* password.verify('pw', bcrypt),
        bcryptWrong: yield* password.verify('nope', bcrypt),
        malformed: yield* password.verify('pw', '$argon2id$garbage'),
      }
    })

    expect(unwrap(outcome)).toEqual({
      argonPrefix: true,
      bcryptPrefix: true,
      argonOk: true,
      argonWrong: false,
      bcryptOk: true,
      bcryptWrong: false,
      malformed: false,
    })
  })
})

describe('NodeIO password — no native hasher', () => {
  it('argon2id / bcrypt hashing and verifying fail unsupported; scrypt is the way', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const { password } = IO.actions

      return {
        hashDefault: errorOf(yield* attempt(() => password.hash('pw'))),
        hashBcrypt: errorOf(yield* attempt(() => password.hash('pw', { algorithm: 'bcrypt' }))),
        verifyArgon: errorOf(
          yield* attempt(() => password.verify('pw', '$argon2id$v=19$m=4096,t=2,p=1$abc$def')),
        ),
        verifyBcrypt: errorOf(yield* attempt(() => password.verify('pw', '$2b$04$abcdef'))),
        verifyGarbage: yield* password.verify('pw', 'garbage'),
      }
    })

    expect(unwrap(outcome)).toEqual({
      hashDefault: IOErrors.Unsupported,
      hashBcrypt: IOErrors.Unsupported,
      verifyArgon: IOErrors.Unsupported,
      verifyBcrypt: IOErrors.Unsupported,
      verifyGarbage: false,
    })
  })
})
