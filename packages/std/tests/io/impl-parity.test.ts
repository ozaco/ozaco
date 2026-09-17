import { attempt, run, sleep } from 'std:effect'
import { IO, IO_FLAGS, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

// BunIO's side of the documented Bun/Node differences (tests/io/node.test.ts holds NodeIO's), and
// one scenario run under BOTH impls for everything they are documented to do identically.

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-parity-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const errorOf = (outcome: unknown): string =>
  isFailure(outcome) ? (outcome.error as string) : 'no-failure'

// an untagged native error rides through `attempt` as the raw Error; `code` is the stable part
const codeOf = (outcome: unknown): string =>
  isFailure(outcome) ? String((outcome.error as { code?: string })?.code) : 'no-failure'

describe('BunIO fs — where it differs from NodeIO', () => {
  it('write without flags creates missing parent directories; with a flag it fails ENOENT', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()

        const plain = yield* attempt(() => IO.actions.write(join(dir, 'a/b/plain.txt'), 'x'))
        const flagged = yield* attempt(() =>
          IO.actions.write(join(dir, 'c/d/flagged.txt'), 'x', { flags: IO_FLAGS.append }),
        )

        return {
          plain: codeOf(plain),
          created: yield* IO.actions.exists(join(dir, 'a/b/plain.txt')),
          flagged: codeOf(flagged),
        }
      })

      expect(unwrap(outcome)).toEqual({ plain: 'no-failure', created: true, flagged: 'ENOENT' })
    })
  })

  it('copy creates missing parent directories unless EXCLUSIVE is set', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* IO.actions.write(join(dir, 'src.txt'), 'payload')

        const plain = yield* attempt(() =>
          IO.actions.copy(join(dir, 'src.txt'), join(dir, 'e/f/copy.txt')),
        )
        const exclusive = yield* attempt(() =>
          IO.actions.copy(join(dir, 'src.txt'), join(dir, 'g/h/copy.txt'), {
            flags: IO_FLAGS.exclusive,
          }),
        )

        return {
          plain: codeOf(plain),
          text: yield* IO.actions.readText(join(dir, 'e/f/copy.txt')),
          exclusive: codeOf(exclusive),
        }
      })

      expect(unwrap(outcome)).toEqual({ plain: 'no-failure', text: 'payload', exclusive: 'ENOENT' })
    })
  })

  it('ensureFile on an existing directory fails with the raw EISDIR', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* IO.actions.ensureDir(join(dir, 'folder'))

        return codeOf(yield* attempt(() => IO.actions.ensureFile(join(dir, 'folder'))))
      })

      expect(unwrap(outcome)).toBe('EISDIR')
    })
  })

  it('rename EXCLUSIVE does not see a directory destination', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* IO.actions.write(join(dir, 'file.txt'), 'x')
        yield* IO.actions.ensureDir(join(dir, 'taken'))
        yield* IO.actions.ensureDir(join(dir, 'moving'))

        const fileOntoDir = yield* attempt(() =>
          IO.actions.rename(join(dir, 'file.txt'), join(dir, 'taken'), {
            flags: IO_FLAGS.exclusive,
          }),
        )
        const dirOntoEmptyDir = yield* attempt(() =>
          IO.actions.rename(join(dir, 'moving'), join(dir, 'taken'), {
            flags: IO_FLAGS.exclusive,
          }),
        )

        return {
          fileOntoDir: codeOf(fileOntoDir),
          dirOntoEmptyDir: codeOf(dirOntoEmptyDir),
          movedAway: !(yield* IO.actions.exists(join(dir, 'moving'))),
        }
      })

      expect(unwrap(outcome)).toEqual({
        fileOntoDir: 'EISDIR',
        dirOntoEmptyDir: 'no-failure',
        movedAway: true,
      })
    })
  })

  it('readText decodes WHATWG labels only — a BufferEncoding like hex throws a RangeError', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* IO.actions.write(join(dir, 't.txt'), 'hi')

        const hex = yield* attempt(() => IO.actions.readText(join(dir, 't.txt'), 'hex'))

        return {
          latin1: yield* IO.actions.readText(join(dir, 't.txt'), 'latin1'),
          hex: isFailure(hex) ? (hex.error as Error).name : 'no-failure',
        }
      })

      expect(unwrap(outcome)).toEqual({ latin1: 'hi', hex: 'RangeError' })
    })
  })
})

describe('BunIO process — where it differs from NodeIO', () => {
  it('kill and write on an already-exited child resolve silently', async () => {
    const outcome = await run(function* () {
      yield* BunIO.use()

      const child = yield* IO.actions.spawn('true')
      yield* child.exited()
      yield* sleep(20)

      return {
        kill: errorOf(yield* attempt(() => child.kill())),
        write: codeOf(yield* attempt(() => child.write('too late'))),
      }
    })

    expect(unwrap(outcome)).toEqual({ kill: 'no-failure', write: 'no-failure' })
  })
})

describe('NodeIO process — stdin after exit', () => {
  it('write on an already-exited child surfaces the raw stream error, untagged', async () => {
    const outcome = await run(function* () {
      yield* NodeIO.use()

      const child = yield* IO.actions.spawn('true')
      yield* child.exited()
      yield* sleep(20)

      const write = yield* attempt(() => child.write('too late'))
      return { tagged: errorOf(write) === IOErrors.StdinWriteFailed, code: codeOf(write) }
    })

    expect(unwrap(outcome)).toEqual({ tagged: false, code: 'ERR_STREAM_DESTROYED' })
  })
})

for (const [label, Impl] of [
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const) {
  describe(`${label} — behaviour both impls share`, () => {
    it('kill accepts a signal NAME as well as a number', async () => {
      const outcome = await run(function* () {
        yield* Impl.use()

        const child = yield* IO.actions.spawn('sleep', ['5'])
        yield* child.kill('SIGKILL')
        return (yield* child.exited()).signal
      })

      expect(unwrap(outcome)).toBe('SIGKILL')
    })

    it('the flag matrix maps the same way for write: append / exclusive / both / neither', async () => {
      await withTempDir(async dir => {
        const outcome = await run(function* () {
          yield* Impl.use()
          const file = join(dir, 'matrix.txt')

          yield* IO.actions.write(file, 'a', { flags: IO_FLAGS.exclusive })
          const again = yield* attempt(() =>
            IO.actions.write(file, 'b', { flags: IO_FLAGS.exclusive }),
          )
          yield* IO.actions.write(file, 'c', { flags: IO_FLAGS.append })
          const both = yield* attempt(() =>
            IO.actions.write(file, 'd', { flags: IO_FLAGS.append | IO_FLAGS.exclusive }),
          )
          const appended = yield* IO.actions.readText(file)
          // a bit neither action knows is ignored: it truncates like a plain write
          yield* IO.actions.write(file, 'z', { flags: IO_FLAGS.files })

          return {
            again: codeOf(again),
            both: codeOf(both),
            appended,
            truncated: yield* IO.actions.readText(file),
          }
        })

        expect(unwrap(outcome)).toEqual({
          again: 'EEXIST',
          both: 'EEXIST',
          appended: 'ac',
          truncated: 'z',
        })
      })
    })

    it('copy / rename consult only the exclusive bit of flags', async () => {
      await withTempDir(async dir => {
        const outcome = await run(function* () {
          yield* Impl.use()
          yield* IO.actions.write(join(dir, 'src.txt'), 'new')
          yield* IO.actions.write(join(dir, 'dest.txt'), 'old')

          // `append` means nothing to copy: the destination is overwritten, not appended to
          yield* IO.actions.copy(join(dir, 'src.txt'), join(dir, 'dest.txt'), {
            flags: IO_FLAGS.append,
          })
          const copied = yield* IO.actions.readText(join(dir, 'dest.txt'))

          const renamed = yield* attempt(() =>
            IO.actions.rename(join(dir, 'src.txt'), join(dir, 'dest.txt'), {
              flags: IO_FLAGS.append | IO_FLAGS.exclusive,
            }),
          )

          return { copied, renamed: errorOf(renamed) }
        })

        expect(unwrap(outcome)).toEqual({ copied: 'new', renamed: IOErrors.Exists })
      })
    })

    it('append forwards to fs.appendFile — a string works at runtime although the type says bytes', async () => {
      await withTempDir(async dir => {
        const outcome = await run(function* () {
          yield* Impl.use()
          const file = join(dir, 'log.txt')

          yield* IO.actions.append(file, new TextEncoder().encode('bytes;'))
          yield* IO.actions.append(file, 'text' as unknown as Uint8Array)

          return yield* IO.actions.readText(file)
        })

        expect(unwrap(outcome)).toBe('bytes;text')
      })
    })

    it('the plain fs handlers answer the same on either impl', async () => {
      await withTempDir(async dir => {
        const outcome = await run(function* () {
          yield* Impl.use()

          yield* IO.actions.ensureDir(join(dir, 'tree/sub'))
          yield* IO.actions.write(join(dir, 'tree/a.txt'), 'aa')
          yield* IO.actions.write(join(dir, 'tree/sub/b.txt'), 'b')
          yield* IO.actions.symlink(join(dir, 'tree/a.txt'), join(dir, 'tree/link'))
          yield* IO.actions.chmod(join(dir, 'tree/a.txt'), 0o600)

          const stat = yield* IO.actions.stat(join(dir, 'tree/link'))
          const lstat = yield* IO.actions.lstat(join(dir, 'tree/link'))
          const listed = (yield* IO.actions.readdir(join(dir, 'tree'))).toSorted()
          const walked = (yield* IO.actions.walk(join(dir, 'tree'), { flags: IO_FLAGS.files }))
            .map(entry => entry.name)
            .toSorted()
          const target = yield* IO.actions.readlink(join(dir, 'tree/link'))

          yield* IO.actions.emptyDir(join(dir, 'tree/sub'))
          const emptied = yield* IO.actions.readdir(join(dir, 'tree/sub'))
          yield* IO.actions.rm(join(dir, 'tree'), { recursive: true })
          const missing = yield* attempt(() => IO.actions.rm(join(dir, 'tree')))

          return {
            stat: { file: stat.isFile, link: stat.isSymlink, size: stat.size },
            lstat: { file: lstat.isFile, link: lstat.isSymlink },
            listed,
            walked,
            sameTarget: target === join(dir, 'tree/a.txt'),
            emptied,
            gone: !(yield* IO.actions.exists(join(dir, 'tree'))),
            missing: codeOf(missing),
          }
        })

        expect(unwrap(outcome)).toEqual({
          stat: { file: true, link: false, size: 2 },
          lstat: { file: false, link: true },
          listed: ['a.txt', 'link', 'sub'],
          // a symlink is a leaf `isSymlink` entry, not a file, unless followSymlinks is set
          walked: ['a.txt', 'b.txt'],
          sameTarget: true,
          emptied: [],
          gone: true,
          missing: 'ENOENT',
        })
      })
    })
  })
}
