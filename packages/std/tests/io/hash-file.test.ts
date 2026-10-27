import { attempt, run } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'
import { WebIO } from 'std:io/impl/web'

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-hash-'))

  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: hashFile', (_, impl) => {
  it('digests a multi-chunk file to the same bytes as hashing its content whole', async () => {
    await withTempDir(async dir => {
      // 1 MiB + 1: more than one 64 KiB read chunk, and not a multiple of it
      const bytes = new Uint8Array(1024 * 1024 + 1)

      for (let at = 0; at < bytes.length; at += 1) {
        bytes[at] = (at * 7 + 3) & 0xff
      }

      const file = join(dir, 'big.bin')

      await writeFile(file, bytes)

      const outcome = await run(function* () {
        yield* impl.use()

        const whole = yield* IO.actions.hash('SHA-256', bytes, { encoding: 'hex' })
        const streamed = yield* IO.actions.hashFile(file, 'SHA-256', { encoding: 'hex' })
        const raw = yield* IO.actions.hashFile(file, 'SHA-256')
        const base64 = yield* IO.actions.hashFile(file, 'SHA-512', { encoding: 'base64' })

        return {
          same: whole === streamed,
          rawLength: raw.length,
          base64: base64 === (yield* IO.actions.hash('SHA-512', bytes, { encoding: 'base64' })),
        }
      })

      expect(unwrap(outcome)).toEqual({ same: true, rawLength: 32, base64: true })
    })
  })

  it('a missing file fails std:io.not-found', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* impl.use()

        const result = yield* attempt(() => IO.actions.hashFile(join(dir, 'nope.bin'), 'SHA-256'))

        return isFailure(result) ? result.error : 'no-failure'
      })

      expect(unwrap(outcome)).toBe(IOErrors.NotFound)
    })
  })
})

describe('hash of a string', () => {
  it.each([
    ['BunIO', BunIO],
    ['NodeIO', NodeIO],
    ['WebIO', WebIO],
  ] as const)('%s: digests the UTF-8 bytes (the SHA-256 "abc" vector)', async (_, impl) => {
    const outcome = await run(function* () {
      yield* impl.use()

      return {
        hex: yield* IO.actions.hash('SHA-256', 'abc', { encoding: 'hex' }),
        bytes: (yield* IO.actions.hash('SHA-256', 'abc')).length,
        utf8:
          (yield* IO.actions.hash('SHA-256', 'çok güzel', { encoding: 'hex' })) ===
          (yield* IO.actions.hash('SHA-256', new TextEncoder().encode('çok güzel'), {
            encoding: 'hex',
          })),
      }
    })

    expect(unwrap(outcome)).toEqual({
      hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      bytes: 32,
      utf8: true,
    })
  })
})
