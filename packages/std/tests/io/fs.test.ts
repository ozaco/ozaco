import { attempt, run } from 'std:effect'
import { IO, IO_FLAGS, toPath } from 'std:io'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, stat as nodeStat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BunIO } from 'std:io/impl/bun'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'ozaco-io-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('files', () => {
  it('write/read/readText/exists/stat round-trip', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const file = join(dir, 'notes.txt')
        yield* IO.actions.write(file, 'hello world — café')

        const bytes = yield* IO.actions.read(file)
        const text = yield* IO.actions.readText(file)
        const info = yield* IO.actions.stat(file)

        return {
          text,
          bytesMatch: decoder.decode(bytes) === 'hello world — café',
          fileExists: yield* IO.actions.exists(file),
          dirExists: yield* IO.actions.exists(dir),
          missingExists: yield* IO.actions.exists(join(dir, 'nope.txt')),
          isFile: info.isFile,
          size: info.size,
          mtimeIsDate: info.mtime instanceof Date,
        }
      })

      expect(unwrap(outcome)).toEqual({
        text: 'hello world — café',
        bytesMatch: true,
        fileExists: true,
        dirExists: true,
        missingExists: false,
        isFile: true,
        size: encoder.encode('hello world — café').length,
        mtimeIsDate: true,
      })
    })
  })

  it('write flags: APPEND appends, EXCLUSIVE refuses an existing file', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const file = join(dir, 'log.txt')
        yield* IO.actions.write(file, 'one')
        yield* IO.actions.write(file, '-two', { flags: IO_FLAGS.APPEND })
        yield* IO.actions.append(file, encoder.encode('-three'))

        const clash = yield* attempt(() =>
          IO.actions.write(file, 'x', { flags: IO_FLAGS.EXCLUSIVE }),
        )

        const fresh = join(dir, 'fresh.txt')
        yield* IO.actions.write(fresh, 'new', { flags: IO_FLAGS.EXCLUSIVE })

        return {
          text: yield* IO.actions.readText(file),
          clashFailed: isFailure(clash),
          freshText: yield* IO.actions.readText(fresh),
        }
      })

      expect(unwrap(outcome)).toEqual({
        text: 'one-two-three',
        clashFailed: true,
        freshText: 'new',
      })
    })
  })

  it('copy and rename move content; EXCLUSIVE variants refuse existing destinations', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const src = join(dir, 'src.txt')
        yield* IO.actions.write(src, 'payload')

        const copied = join(dir, 'copy.txt')
        yield* IO.actions.copy(src, copied)

        const renamed = join(dir, 'renamed.txt')
        yield* IO.actions.rename(copied, renamed)

        const blocker = join(dir, 'blocker.txt')
        yield* IO.actions.write(blocker, 'keep')

        const renameClash = yield* attempt(() =>
          IO.actions.rename(renamed, blocker, { flags: IO_FLAGS.EXCLUSIVE }),
        )
        const copyClash = yield* attempt(() =>
          IO.actions.copy(src, blocker, { flags: IO_FLAGS.EXCLUSIVE }),
        )

        return {
          copiedGone: yield* IO.actions.exists(copied),
          renamedText: yield* IO.actions.readText(renamed),
          renameError: isFailure(renameClash) ? renameClash.error : 'no-failure',
          copyClashFailed: isFailure(copyClash),
          blockerText: yield* IO.actions.readText(blocker),
        }
      })

      expect(unwrap(outcome)).toEqual({
        copiedGone: false,
        renamedText: 'payload',
        renameError: 'exists',
        copyClashFailed: true,
        blockerText: 'keep',
      })
    })
  })

  it('rm removes recursively; missing paths fail unless force is set', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const nested = join(dir, 'a', 'b')
        yield* IO.actions.ensureDir(nested)
        yield* IO.actions.write(join(nested, 'f.txt'), 'x')
        yield* IO.actions.rm(join(dir, 'a'), { recursive: true })

        yield* IO.actions.rm(join(dir, 'missing'), { force: true })
        const strict = yield* attempt(() => IO.actions.rm(join(dir, 'missing-too')))

        return {
          gone: yield* IO.actions.exists(join(dir, 'a')),
          strictFailed: isFailure(strict),
        }
      })

      expect(unwrap(outcome)).toEqual({ gone: false, strictFailed: true })
    })
  })

  it('symlink/readlink; lstat sees the link, stat follows it; chmod changes the mode', async () => {
    await withTempDir(async dir => {
      const target = join(dir, 'target.txt')

      const outcome = await run(function* () {
        yield* install(BunIO)

        yield* IO.actions.write(target, 'data')

        const link = join(dir, 'link.txt')
        yield* IO.actions.symlink(target, link)

        const followed = yield* IO.actions.stat(link)
        const raw = yield* IO.actions.lstat(link)
        const dirInfo = yield* IO.actions.stat(dir)

        yield* IO.actions.chmod(target, 0o400)

        return {
          linkTarget: yield* IO.actions.readlink(link),
          followedIsFile: followed.isFile,
          followedIsSymlink: followed.isSymlink,
          rawIsSymlink: raw.isSymlink,
          dirIsDirectory: dirInfo.isDirectory,
        }
      })

      expect(unwrap(outcome)).toEqual({
        linkTarget: target,
        followedIsFile: true,
        followedIsSymlink: false,
        rawIsSymlink: true,
        dirIsDirectory: true,
      })

      const targetInfo = await nodeStat(target)
      expect(targetInfo.mode & 0o777).toBe(0o400)
    })
  })

  it('readdir lists entries (recursive too); ensureFile/emptyDir behave idempotently', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        yield* IO.actions.ensureDir(join(dir, 'sub'))
        yield* IO.actions.write(join(dir, 'a.txt'), '1')
        yield* IO.actions.write(join(dir, 'sub', 'b.txt'), '2')

        const flat = (yield* IO.actions.readdir(dir)).toSorted()
        const recursive = (yield* IO.actions.readdir(dir, { recursive: true })).toSorted()

        const kept = join(dir, 'kept.txt')
        yield* IO.actions.write(kept, 'keep')
        yield* IO.actions.ensureFile(kept)

        const made = join(dir, 'deep', 'made.txt')
        yield* IO.actions.ensureFile(made)

        yield* IO.actions.emptyDir(join(dir, 'sub'))
        const brandNew = join(dir, 'brand-new')
        yield* IO.actions.emptyDir(brandNew)

        return {
          flat,
          recursive,
          keptText: yield* IO.actions.readText(kept),
          madeText: yield* IO.actions.readText(made),
          emptied: yield* IO.actions.readdir(join(dir, 'sub')),
          createdEmpty: yield* IO.actions.exists(brandNew),
        }
      })

      expect(unwrap(outcome)).toEqual({
        flat: ['a.txt', 'sub'],
        recursive: ['a.txt', 'sub', join('sub', 'b.txt')],
        keptText: 'keep',
        madeText: '',
        emptied: [],
        createdEmpty: true,
      })
    })
  })
})

describe('walk', () => {
  const fixture = function* (dir: string) {
    yield* IO.actions.ensureDir(join(dir, 'sub', 'deep'))
    yield* IO.actions.write(join(dir, 'a.txt'), 'a')
    yield* IO.actions.write(join(dir, 'sub', 'b.txt'), 'b')
    yield* IO.actions.write(join(dir, 'sub', 'deep', 'c.log'), 'c')
  }

  it('default flags list files and dirs; FILES narrows; maxDepth bounds recursion', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)
        yield* fixture(dir)

        const all = yield* IO.actions.walk(dir)
        const filesOnly = yield* IO.actions.walk(dir, { flags: IO_FLAGS.FILES })
        const shallow = yield* IO.actions.walk(dir, {
          flags: IO_FLAGS.FILES | IO_FLAGS.DIRS,
          maxDepth: 0,
        })

        return {
          all: all.map(entry => entry.name).toSorted(),
          filesOnly: filesOnly.map(entry => entry.name).toSorted(),
          filesAreFiles: filesOnly.every(entry => entry.isFile),
          shallow: shallow.map(entry => entry.name).toSorted(),
        }
      })

      expect(unwrap(outcome)).toEqual({
        all: ['a.txt', 'b.txt', 'c.log', 'deep', 'sub'],
        filesOnly: ['a.txt', 'b.txt', 'c.log'],
        filesAreFiles: true,
        shallow: ['a.txt', 'sub'],
      })
    })
  })

  it('match keeps matching paths; skip prunes entries and whole subtrees', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)
        yield* fixture(dir)

        const matched = yield* IO.actions.walk(dir, {
          flags: IO_FLAGS.FILES,
          match: [/\.txt$/u],
        })
        const pruned = yield* IO.actions.walk(dir, {
          flags: IO_FLAGS.FILES,
          skip: [/deep/u],
        })

        return {
          matched: matched.map(entry => entry.name).toSorted(),
          pruned: pruned.map(entry => entry.name).toSorted(),
        }
      })

      expect(unwrap(outcome)).toEqual({
        matched: ['a.txt', 'b.txt'],
        pruned: ['a.txt', 'b.txt'],
      })
    })
  })
})

describe('paths', () => {
  it('toPath passes plain strings through and decodes file:// URLs', () => {
    expect(toPath('/plain/path')).toBe('/plain/path')
    expect(toPath('file:///tmp/some%20file.txt')).toBe('/tmp/some file.txt')
    expect(toPath(new URL('file:///tmp/caf%C3%A9.txt'))).toBe('/tmp/café.txt')
  })

  it('actions accept URL paths; path helpers mirror node:path', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const file = join(dir, 'via-url.txt')
        yield* IO.actions.write(pathToFileURL(file), 'through a URL')

        return {
          text: yield* IO.actions.readText(pathToFileURL(file)),
          joined: yield* IO.actions.join('a', 'b', '..', 'c'),
          dir: yield* IO.actions.dirname('/x/y/z.txt'),
          base: yield* IO.actions.basename('/x/y/z.txt', '.txt'),
          ext: yield* IO.actions.extname('archive.tar.gz'),
          abs: yield* IO.actions.isAbsolute('/rooted'),
          rel: yield* IO.actions.isAbsolute('nested/child'),
        }
      })

      expect(unwrap(outcome)).toEqual({
        text: 'through a URL',
        joined: join('a', 'c'),
        dir: '/x/y',
        base: 'z',
        ext: '.gz',
        abs: true,
        rel: false,
      })
    })
  })
})
