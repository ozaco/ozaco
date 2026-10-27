import { attempt, run } from 'std:effect'
import { IO, IO_FLAGS, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

// `write({ atomic, mode })`, `ensureDir({ mode })` and `realpath` — the node:fs path both impls
// share (BunIO leaves its `Bun.write` fast path only when an option is given).

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-atomic-'))

  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const errorOf = (outcome: unknown): string =>
  isFailure(outcome) ? (outcome.error as string) : 'no-failure'

const modeOf = async (path: string) => {
  const info = await stat(path)

  return info.mode & 0o777
}

const leftovers = async (dir: string) => {
  const names = await readdir(dir)

  return names.filter(name => name.endsWith('.tmp'))
}

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: atomic write', (_, impl) => {
  it('replaces the file whole and leaves no temporary file behind', async () => {
    await withTempDir(async dir => {
      const file = join(dir, 'state.json')

      await writeFile(file, 'old')

      const outcome = await run(function* () {
        yield* impl.use()

        yield* IO.actions.write(file, 'new content', { atomic: true })

        return yield* IO.actions.readText(file)
      })

      expect(unwrap(outcome)).toBe('new content')
      expect(await leftovers(dir)).toEqual([])
    })
  })

  it('a failed rename removes the temporary file and raises the failure', async () => {
    await withTempDir(async dir => {
      // the target is a non-empty DIRECTORY: the write to the temporary file succeeds, the rename
      // over the directory cannot
      const target = join(dir, 'taken')

      await mkdir(target)
      await writeFile(join(target, 'inside'), 'x')

      const outcome = await run(function* () {
        yield* impl.use()

        return errorOf(yield* attempt(() => IO.actions.write(target, 'data', { atomic: true })))
      })

      expect(unwrap(outcome)).not.toBe('no-failure')
      expect(await leftovers(dir)).toEqual([])
      expect(await readFile(join(target, 'inside'), 'utf8')).toBe('x')
    })
  })

  it('refuses IO_FLAGS.append; honours IO_FLAGS.exclusive before writing anything', async () => {
    await withTempDir(async dir => {
      const file = join(dir, 'present')

      await writeFile(file, 'kept')

      const outcome = await run(function* () {
        yield* impl.use()

        const appended = yield* attempt(() =>
          IO.actions.write(file, 'x', { atomic: true, flags: IO_FLAGS.append }),
        )
        const exclusive = yield* attempt(() =>
          IO.actions.write(file, 'x', { atomic: true, flags: IO_FLAGS.exclusive }),
        )

        return { appended: errorOf(appended), exclusive: errorOf(exclusive) }
      })

      expect(unwrap(outcome)).toEqual({
        appended: IOErrors.Unsupported,
        exclusive: IOErrors.Exists,
      })
      expect(await readFile(file, 'utf8')).toBe('kept')
      expect(await leftovers(dir)).toEqual([])
    })
  })

  it('into a missing directory fails std:io.not-found', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* impl.use()

        return errorOf(
          yield* attempt(() => IO.actions.write(join(dir, 'no/such/file'), 'x', { atomic: true })),
        )
      })

      expect(unwrap(outcome)).toBe(IOErrors.NotFound)
    })
  })
})

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: mode', (_, impl) => {
  it('write({ mode }) sets it on a new file, an existing one and an atomic write alike', async () => {
    await withTempDir(async dir => {
      const fresh = join(dir, 'fresh')
      const existing = join(dir, 'existing')
      const atomic = join(dir, 'atomic')

      await writeFile(existing, 'x', { mode: 0o644 })

      const outcome = await run(function* () {
        yield* impl.use()

        yield* IO.actions.write(fresh, 'secret', { mode: 0o600 })
        yield* IO.actions.write(existing, 'secret', { mode: 0o600 })
        yield* IO.actions.write(atomic, 'secret', { mode: 0o600, atomic: true })
      })

      unwrap(outcome)

      expect({
        fresh: await modeOf(fresh),
        existing: await modeOf(existing),
        atomic: await modeOf(atomic),
      }).toEqual({ fresh: 0o600, existing: 0o600, atomic: 0o600 })
    })
  })

  it('ensureDir({ mode }) sets it on a created and on an existing directory', async () => {
    await withTempDir(async dir => {
      const created = join(dir, 'a/b/private')
      const existing = join(dir, 'existing')

      await mkdir(existing, { mode: 0o755 })

      const outcome = await run(function* () {
        yield* impl.use()

        yield* IO.actions.ensureDir(created, { mode: 0o700 })
        yield* IO.actions.ensureDir(existing, { mode: 0o700 })
        // no mode: an existing directory is untouched
        yield* IO.actions.ensureDir(existing)
      })

      unwrap(outcome)

      expect({ created: await modeOf(created), existing: await modeOf(existing) }).toEqual({
        created: 0o700,
        existing: 0o700,
      })
    })
  })
})

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: realpath', (_, impl) => {
  it('resolves every symlink on the way; a missing entry fails std:io.not-found', async () => {
    await withTempDir(async dir => {
      const real = join(dir, 'real')
      const link = join(dir, 'link')

      await mkdir(real)
      await writeFile(join(real, 'file'), 'x')
      await symlink(real, link)

      const outcome = await run(function* () {
        yield* impl.use()

        const viaLink = yield* IO.actions.realpath(join(link, 'file'))
        const direct = yield* IO.actions.realpath(join(real, 'file'))
        const missing = yield* attempt(() => IO.actions.realpath(join(dir, 'missing')))

        return {
          same: viaLink === direct,
          endsReal: direct.endsWith('/real/file'),
          absolute: yield* IO.actions.isAbsolute(direct),
          missing: errorOf(missing),
        }
      })

      expect(unwrap(outcome)).toEqual({
        same: true,
        endsReal: true,
        absolute: true,
        missing: IOErrors.NotFound,
      })
    })
  })
})
