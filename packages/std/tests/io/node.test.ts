import { attempt, run } from 'std:effect'
import { IO, IO_FLAGS, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeIO } from 'std:io/impl/node'

// NodeIO under test. Every other io suite installs BunIO (or WebIO); this one pins the Bun/Node
// divergences listed in AUDIT.md §10 (I9–I18) with Node's OBSERVED behavior — the `node:*` APIs as
// run by the test host — so a future unification has a pinned baseline for the Node side.

const decoder = new TextDecoder()

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-node-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const errorOf = (outcome: unknown): string =>
  isFailure(outcome) ? (outcome.error as string) : 'no-failure'

// An untagged native error (e.g. an `fs` ENOENT) rides through `attempt` as the raw Error in
// `failure.error`; its `code` is the stable thing to assert on.
const codeOf = (outcome: unknown): string =>
  isFailure(outcome) ? String((outcome.error as { code?: string })?.code) : 'no-failure'

describe('NodeIO installs', () => {
  it('registers as std/node-io and serves the shared crypto/id actions', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const digest = yield* IO.actions.hash('SHA-256', new TextEncoder().encode('abc'))
      const id = yield* IO.actions.uuid()

      return {
        name: NodeIO.name,
        digestHead: Array.from(digest.slice(0, 4), byte => byte.toString(16).padStart(2, '0')).join(
          '',
        ),
        uuidShape: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          id,
        ),
      }
    })

    expect(unwrap(outcome)).toEqual({
      name: 'std/node-io',
      digestHead: 'ba7816bf',
      uuidShape: true,
    })
  })
})

describe('NodeIO fs divergences (I9–I13)', () => {
  it('I9: write without flags into a missing directory fails ENOENT (Bun.write would create it)', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* NodeIO.use()

        const result = yield* attempt(() =>
          IO.actions.write(join(dir, 'missing', 'nested', 'file.txt'), 'data'),
        )
        const created = yield* IO.actions.exists(join(dir, 'missing'))

        return { code: codeOf(result), created }
      })

      expect(unwrap(outcome)).toEqual({ code: 'ENOENT', created: false })
    })
  })

  it('I10: copy into a missing directory fails ENOENT (Bun.write would create it)', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* NodeIO.use()

        const src = join(dir, 'src.txt')
        yield* IO.actions.write(src, 'payload')
        const result = yield* attempt(() => IO.actions.copy(src, join(dir, 'missing', 'dest.txt')))

        return codeOf(result)
      })

      expect(unwrap(outcome)).toBe('ENOENT')
    })
  })

  it('I11: ensureFile on an existing directory is a no-op (Bun throws)', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* NodeIO.use()

        const existing = join(dir, 'already-a-dir')
        yield* IO.actions.ensureDir(existing)
        yield* IO.actions.ensureFile(existing)
        const info = yield* IO.actions.stat(existing)

        return { isDirectory: info.isDirectory, isFile: info.isFile }
      })

      expect(unwrap(outcome)).toEqual({ isDirectory: true, isFile: false })
    })
  })

  it('I12: rename EXCLUSIVE onto an existing directory fails std:io.exists (Bun bypasses the guard)', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* NodeIO.use()

        const src = join(dir, 'src.txt')
        const blockerDir = join(dir, 'blocker')
        yield* IO.actions.write(src, 'x')
        yield* IO.actions.ensureDir(blockerDir)

        const result = yield* attempt(() =>
          IO.actions.rename(src, blockerDir, { flags: IO_FLAGS.EXCLUSIVE }),
        )

        return { error: errorOf(result), srcStillThere: yield* IO.actions.exists(src) }
      })

      expect(unwrap(outcome)).toEqual({ error: IOErrors.Exists, srcStillThere: true })
    })
  })

  it("I13: readText accepts any BufferEncoding — 'hex' and 'base64' decode (Bun's TextDecoder throws)", async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* NodeIO.use()

        const file = join(dir, 'bytes.bin')
        yield* IO.actions.write(file, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))

        return {
          hex: yield* IO.actions.readText(file, 'hex'),
          base64: yield* IO.actions.readText(file, 'base64'),
          utf8: yield* IO.actions.readText(file),
        }
      })

      const got = unwrap(outcome)
      expect(got.hex).toBe('deadbeef')
      expect(got.base64).toBe('3q2+7w==')
      expect(typeof got.utf8).toBe('string')
    })
  })
})

describe('NodeIO crypto divergences (I14)', () => {
  it('randomBytes(70000) succeeds — node:crypto has no 65536-byte WebCrypto cap', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const bytes = yield* IO.actions.randomBytes(70_000)
      return { length: bytes.length, notAllZero: bytes.some(byte => byte !== 0) }
    })

    expect(unwrap(outcome)).toEqual({ length: 70_000, notAllZero: true })
  })
})

describe('NodeIO process divergences (I15–I17)', () => {
  it('I15: exec of a missing binary fails std:io.exec-failed (Bun: exec-spawn-failed)', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const result = yield* attempt(() => IO.actions.exec('ozaco-definitely-not-a-binary'))
      return errorOf(result)
    })

    expect(unwrap(outcome)).toBe(IOErrors.ExecFailed)
  })

  it('I16: spawn of a missing binary yields a handle whose exited() fails std:io.process-error', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const spawned = yield* attempt(() => IO.actions.spawn('ozaco-definitely-not-a-binary'))
      if (isFailure(spawned)) {
        return { stage: 'spawn', pid: -1, error: spawned.error as string }
      }
      const status = yield* attempt(() => spawned.value.exited())
      return { stage: 'exited', pid: spawned.value.pid, error: errorOf(status) }
    })

    // Node surfaces the launch failure asynchronously: the handle exists (pid -1), exited() fails
    expect(unwrap(outcome)).toEqual({ stage: 'exited', pid: -1, error: IOErrors.ProcessError })
  })

  it('I17: kill on an already-exited child fails std:io.kill-failed (Bun succeeds silently)', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const handle = yield* IO.actions.spawn('true')
      const status = yield* handle.exited()
      const killed = yield* attempt(() => handle.kill())

      return { code: status.code, error: errorOf(killed) }
    })

    expect(unwrap(outcome)).toEqual({ code: 0, error: IOErrors.KillFailed })
  })

  it('exec still round-trips stdout/stdin through node:child_process', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const result = yield* IO.actions.exec('cat', [], { stdin: 'via-node' })
      return { stdout: decoder.decode(result.stdout), success: result.success }
    })

    expect(unwrap(outcome)).toEqual({ stdout: 'via-node', success: true })
  })
})
