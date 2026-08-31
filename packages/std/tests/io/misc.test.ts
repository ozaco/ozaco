import { attempt, run, sleep, spawn, withResolvers } from 'std:effect'
import type { WatchEvent } from 'std:io'
import { IO } from 'std:io'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'
import { WebIO } from 'std:io/impl/web'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

describe('env', () => {
  it('maps present variables, tolerates declared-optional ones, fails on missing required', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const parsed = yield* IO.actions.env(
        data => ({ path: data.PATH, extra: data.OZACO_IO_TEST_NOT_SET }),
        ['extra'],
      )

      const missing = yield* attempt(() =>
        IO.actions.env(data => ({ needed: data.OZACO_IO_TEST_NOT_SET })),
      )

      return {
        hasPath: typeof parsed.path === 'string' && parsed.path.length > 0,
        extra: parsed.extra,
        missingError: isFailure(missing) ? missing.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      hasPath: true,
      extra: undefined,
      missingError: 'missing-env',
    })
  })
})

describe('ids and randomness', () => {
  it('randomBytes/uuid/ulid produce well-formed, distinct values', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const bytes = yield* IO.actions.randomBytes(32)
      const uuidA = yield* IO.actions.uuid()
      const uuidB = yield* IO.actions.uuid()
      const ulidA = yield* IO.actions.ulid()
      const ulidB = yield* IO.actions.ulid()
      const bucketed = yield* IO.actions.ulid({ bucket: 'user_', length: 20 })

      return {
        length: bytes.length,
        notAllZero: bytes.some(byte => byte !== 0),
        uuidShape: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          uuidA,
        ),
        uuidsDistinct: uuidA !== uuidB,
        ulidShape: /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(ulidA),
        ulidsOrdered: ulidA < ulidB,
        bucketed: bucketed.startsWith('user_') && bucketed.length === 'user_'.length + 20,
      }
    })

    expect(unwrap(outcome)).toEqual({
      length: 32,
      notAllZero: true,
      uuidShape: true,
      uuidsDistinct: true,
      ulidShape: true,
      ulidsOrdered: true,
      bucketed: true,
    })
  })
})

describe('hashing', () => {
  it('hash and hmac match known SHA-256 vectors', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const digest = yield* IO.actions.hash('SHA-256', encoder.encode('abc'))
      const mac = yield* IO.actions.hmac(
        'SHA-256',
        encoder.encode('key'),
        encoder.encode('The quick brown fox jumps over the lazy dog'),
      )

      return { digest: toHex(digest), mac: toHex(mac) }
    })

    expect(unwrap(outcome)).toEqual({
      digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      mac: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    })
  })
})

describe('secretbox (encrypt/decrypt)', () => {
  it('round-trips bytes and string input under the same secret', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const sealed = yield* IO.actions.encrypt('very secret data', 'passphrase-123')
      const opened = yield* IO.actions.decrypt(sealed, 'passphrase-123')

      return {
        text: decoder.decode(opened),
        ciphertextDiffers: decoder.decode(sealed) !== 'very secret data',
      }
    })

    expect(unwrap(outcome)).toEqual({ text: 'very secret data', ciphertextDiffers: true })
  })

  it('a wrong secret or tampered ciphertext fails with decrypt-failed', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const sealed = yield* IO.actions.encrypt('secret', 'right-passphrase')

      const wrongSecret = yield* attempt(() => IO.actions.decrypt(sealed, 'wrong-passphrase'))

      const tampered = Uint8Array.from(sealed)
      tampered[tampered.length - 1]! ^= 0xff
      const corrupted = yield* attempt(() => IO.actions.decrypt(tampered, 'right-passphrase'))

      return {
        wrongSecret: isFailure(wrongSecret) ? wrongSecret.error : 'no-failure',
        corrupted: isFailure(corrupted) ? corrupted.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      wrongSecret: 'decrypt-failed',
      corrupted: 'decrypt-failed',
    })
  })
})

describe('signatures', () => {
  it('sign/verify round-trips; altered data fails; a malformed key is a tagged Failure', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const pair = yield* IO.actions.generateKeyPair()
      const signature = yield* IO.actions.sign('signed message', pair.privateKey)

      const valid = yield* IO.actions.verify('signed message', signature, pair.publicKey)
      const altered = yield* IO.actions.verify('other message', signature, pair.publicKey)

      const broken = yield* attempt(() => IO.actions.sign('message', pair.privateKey.slice(0, 10)))

      return {
        signatureLength: signature.length,
        valid,
        altered,
        brokenKey: isFailure(broken) ? broken.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      signatureLength: 64,
      valid: true,
      altered: false,
      brokenKey: 'sign-failed',
    })
  })
})

describe('system', () => {
  it('ip lists interfaces and tmpdir mirrors the OS temp directory', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const interfaces = yield* IO.actions.ip()

      return {
        hasInterfaces: interfaces.length > 0,
        shapesOk: interfaces.every(
          entry =>
            typeof entry.name === 'string' &&
            typeof entry.address === 'string' &&
            typeof entry.internal === 'boolean',
        ),
        tmp: yield* IO.actions.tmpdir(),
      }
    })

    expect(unwrap(outcome)).toEqual({
      hasInterfaces: true,
      shapesOk: true,
      tmp: osTmpdir(),
    })
  })
})

describe('watch', () => {
  it('a file change in a watched directory emits a WatchEvent', async () => {
    const dir = await mkdtemp(join(osTmpdir(), 'ozaco-io-'))
    // force the deterministic fs.watch fallback — Watchman availability varies per machine
    const previous = process.env.STD_WATCHMAN
    process.env.STD_WATCHMAN = 'off'

    try {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const events = yield* IO.actions.watch(dir)
        const got = withResolvers<WatchEvent>()

        yield* spawn(function* () {
          const first = yield* events.next()
          if (!first.done) {
            got.resolve(first.value)
          }
        })

        // poke the directory until the watcher reports; fs.watch arms asynchronously
        yield* spawn(function* () {
          for (let tick = 0; tick < 25; tick++) {
            yield* IO.actions.write(join(dir, 'poke.txt'), `tick-${tick}`)
            yield* sleep(100)
          }
        })

        return yield* got.operation
      })

      const event = unwrap(outcome)
      expect(event.type === 'rename' || event.type === 'change').toBe(true)
      expect(event.path).toBe('poke.txt')
    } finally {
      if (previous === undefined) {
        delete process.env.STD_WATCHMAN
      } else {
        process.env.STD_WATCHMAN = previous
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 4000)
})

describe('web impl', () => {
  it('unsupported actions fail cleanly as Results while crypto keeps working', async () => {
    const outcome = await run(function* () {
      yield* install(WebIO)

      const read = yield* attempt(() => IO.actions.read('/nowhere.txt'))
      const exec = yield* attempt(() => IO.actions.exec('echo'))
      const bytes = yield* IO.actions.randomBytes(8)

      return {
        readError: isFailure(read) ? read.error : 'no-failure',
        execError: isFailure(exec) ? exec.error : 'no-failure',
        bytesLength: bytes.length,
      }
    })

    expect(unwrap(outcome)).toEqual({
      readError: 'io-unsupported',
      execError: 'io-unsupported',
      bytesLength: 8,
    })
  })
})

describe('protocol wiring', () => {
  it('actions without an installed impl fail with missing-action', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(() => IO.actions.read('/nowhere.txt'))
      return isFailure(result) ? result.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('missing-action')
  })

  it('the io protocol is single-impl: a second impl refuses to install', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)
      const second = yield* attempt(() => install(WebIO))

      return isFailure(second) ? second.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('protocol-not-cloneable')
  })
})
