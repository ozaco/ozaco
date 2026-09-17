import { attempt, run } from 'std:effect'
import { IO, IO_FLAGS } from 'std:io'
import { isFailure, unwrap } from 'std:result'
import { hasFlag } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunIO } from 'std:io/impl/bun'

// `IO_FLAGS` is a bitfield allocated from bit 0 (followSymlinks=1, files=2, dirs=4, append=8,
// exclusive=16). These tests pin the numeric layout and that every consumer honors its bit.

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-flags-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('IO_FLAGS layout', () => {
  it('starts at 1 << 0 with the documented values', () => {
    expect(IO_FLAGS.none).toBe(0)
    expect(IO_FLAGS.followSymlinks).toBe(1)
    expect(IO_FLAGS.files).toBe(2)
    expect(IO_FLAGS.dirs).toBe(4)
    expect(IO_FLAGS.append).toBe(8)
    expect(IO_FLAGS.exclusive).toBe(16)
  })

  it('every flag is a distinct single bit and combines without overlap', () => {
    const bits = [
      IO_FLAGS.followSymlinks,
      IO_FLAGS.files,
      IO_FLAGS.dirs,
      IO_FLAGS.append,
      IO_FLAGS.exclusive,
    ]
    for (const bit of bits) {
      // a power of two has exactly one bit set
      expect(bit > 0 && (bit & (bit - 1)) === 0).toBe(true)
    }
    expect(new Set(bits).size).toBe(bits.length)
    const all = bits.reduce((acc, bit) => acc | bit, 0)
    expect(all).toBe(31)
    for (const bit of bits) {
      expect(hasFlag(all, bit)).toBe(true)
      expect(hasFlag(all & ~bit, bit)).toBe(false)
    }
    expect(hasFlag(IO_FLAGS.none, IO_FLAGS.files)).toBe(false)
  })
})

describe('walk honors FILES / DIRS / FOLLOW_SYMLINKS', () => {
  const fixture = function* (dir: string) {
    yield* IO.actions.ensureDir(join(dir, 'real'))
    yield* IO.actions.write(join(dir, 'top.txt'), 't')
    yield* IO.actions.write(join(dir, 'real', 'inner.txt'), 'i')
    yield* IO.actions.symlink(join(dir, 'real'), join(dir, 'link'), 'dir')
  }

  it('FILES vs DIRS vs both select which entries are collected', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* fixture(dir)

        const files = yield* IO.actions.walk(dir, { flags: IO_FLAGS.files })
        const dirs = yield* IO.actions.walk(dir, { flags: IO_FLAGS.dirs })
        const both = yield* IO.actions.walk(dir, { flags: IO_FLAGS.files | IO_FLAGS.dirs })
        const neither = yield* IO.actions.walk(dir, { flags: IO_FLAGS.none })

        return {
          files: files.map(entry => entry.name).toSorted(),
          filesAreFiles: files.every(entry => entry.isFile),
          dirs: dirs.map(entry => entry.name).toSorted(),
          dirsAreDirs: dirs.every(entry => entry.isDirectory),
          both: both.map(entry => entry.name).toSorted(),
          neither: neither.length,
        }
      })

      // without FOLLOW_SYMLINKS `link` is a symlink leaf: neither a file nor a directory, so it is
      // never collected and never descended into
      expect(unwrap(outcome)).toEqual({
        files: ['inner.txt', 'top.txt'],
        filesAreFiles: true,
        dirs: ['real'],
        dirsAreDirs: true,
        both: ['inner.txt', 'real', 'top.txt'],
        neither: 0,
      })
    })
  })

  it('FOLLOW_SYMLINKS reports a symlinked directory as a directory and walks through it', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()
        yield* fixture(dir)

        const followed = yield* IO.actions.walk(dir, {
          flags: IO_FLAGS.files | IO_FLAGS.dirs | IO_FLAGS.followSymlinks,
        })
        const link = followed.find(entry => entry.name === 'link')

        return {
          paths: followed.map(entry => entry.path.slice(dir.length + 1)).toSorted(),
          linkIsDirectory: link?.isDirectory ?? null,
          linkIsSymlink: link?.isSymlink ?? null,
        }
      })

      expect(unwrap(outcome)).toEqual({
        paths: ['link', join('link', 'inner.txt'), 'real', join('real', 'inner.txt'), 'top.txt'],
        // `stat` follows the link, so it is a plain directory from walk's point of view
        linkIsDirectory: true,
        linkIsSymlink: false,
      })
    })
  })
})

describe('write honors APPEND / EXCLUSIVE', () => {
  it('APPEND appends; EXCLUSIVE refuses an existing file and creates a fresh one', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* BunIO.use()

        const file = join(dir, 'log.txt')
        yield* IO.actions.write(file, 'one')
        yield* IO.actions.write(file, '-two', { flags: IO_FLAGS.append })
        yield* IO.actions.write(file, '-three', { flags: IO_FLAGS.append })
        const appended = yield* IO.actions.readText(file)

        const refused = yield* attempt(() =>
          IO.actions.write(file, 'clobber', { flags: IO_FLAGS.exclusive }),
        )
        const untouched = yield* IO.actions.readText(file)

        const fresh = join(dir, 'fresh.txt')
        yield* IO.actions.write(fresh, 'new', { flags: IO_FLAGS.exclusive })

        const appendExclusiveExisting = yield* attempt(() =>
          IO.actions.write(file, 'x', { flags: IO_FLAGS.append | IO_FLAGS.exclusive }),
        )
        const appendExclusiveFresh = join(dir, 'fresh-append.txt')
        yield* IO.actions.write(appendExclusiveFresh, 'ax', {
          flags: IO_FLAGS.append | IO_FLAGS.exclusive,
        })

        return {
          appended,
          refused: isFailure(refused),
          untouched,
          fresh: yield* IO.actions.readText(fresh),
          appendExclusiveExisting: isFailure(appendExclusiveExisting),
          appendExclusiveFresh: yield* IO.actions.readText(appendExclusiveFresh),
        }
      })

      expect(unwrap(outcome)).toEqual({
        appended: 'one-two-three',
        refused: true,
        untouched: 'one-two-three',
        fresh: 'new',
        appendExclusiveExisting: true,
        appendExclusiveFresh: 'ax',
      })
    })
  })
})
