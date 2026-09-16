import { attempt, run } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { WebIO } from 'std:io/impl/web'

// The hand-rolled POSIX path helpers behind WebIO (src/io/internal/path/web.ts), incl. the
// `normalize` step that `join` applies; and every action WebIO marks `unsupported` fails as a
// tagged Result rather than throwing.

describe('WebIO path helpers (POSIX)', () => {
  it('join normalizes `.`/`..`/empty segments and duplicate separators', async () => {
    const outcome = await run(function* () {
      yield* WebIO.use()
      const joinPath = IO.actions.join
      return {
        plain: yield* joinPath('a', 'b', 'c'),
        dotdot: yield* joinPath('a', 'b', '..', 'c'),
        leadingDotdot: yield* joinPath('..', 'a'),
        doubleDotdot: yield* joinPath('a', '..', '..', 'b'),
        rootDotdot: yield* joinPath('/..', 'a'),
        absolute: yield* joinPath('/a/', 'b'),
        emptySegments: yield* joinPath('a', '', 'b'),
        dots: yield* joinPath('a/./b//c/'),
        collapsesToDot: yield* joinPath('a', '..'),
        noArgs: yield* joinPath(),
        onlyEmpty: yield* joinPath('', ''),
        rootOnly: yield* joinPath('/'),
      }
    })

    expect(unwrap(outcome)).toEqual({
      plain: 'a/b/c',
      dotdot: 'a/c',
      leadingDotdot: '../a',
      doubleDotdot: '../b',
      rootDotdot: '/a',
      absolute: '/a/b',
      emptySegments: 'a/b',
      dots: 'a/b/c',
      collapsesToDot: '.',
      noArgs: '.',
      onlyEmpty: '.',
      rootOnly: '/',
    })
  })

  it('dirname / basename / extname / isAbsolute edge cases', async () => {
    const outcome = await run(function* () {
      yield* WebIO.use()
      const { dirname, basename, extname, isAbsolute } = IO.actions
      return {
        dirNested: yield* dirname('/a/b/c'),
        dirRootChild: yield* dirname('/a'),
        dirBare: yield* dirname('a'),
        dirTrailingSlash: yield* dirname('/a/b/'),
        dirRelative: yield* dirname('a/b'),
        baseFile: yield* basename('/a/b.txt'),
        baseSuffix: yield* basename('/a/b.txt', '.txt'),
        baseSuffixMiss: yield* basename('/a/b.txt', '.md'),
        baseSuffixIsWhole: yield* basename('.txt', '.txt'),
        baseTrailingSlash: yield* basename('/a/b/'),
        baseBare: yield* basename('file'),
        extSimple: yield* extname('a/b.txt'),
        extMulti: yield* extname('a/b.tar.gz'),
        extDotfile: yield* extname('.bashrc'),
        extNone: yield* extname('a/b'),
        extDotInDir: yield* extname('a.b/c'),
        extTrailingDot: yield* extname('a.'),
        absRoot: yield* isAbsolute('/x'),
        absRelative: yield* isAbsolute('x/y'),
        absDot: yield* isAbsolute('./x'),
        absEmpty: yield* isAbsolute(''),
      }
    })

    expect(unwrap(outcome)).toEqual({
      dirNested: '/a/b',
      dirRootChild: '/',
      dirBare: '.',
      dirTrailingSlash: '/a',
      dirRelative: 'a',
      baseFile: 'b.txt',
      baseSuffix: 'b',
      baseSuffixMiss: 'b.txt',
      baseSuffixIsWhole: '.txt',
      baseTrailingSlash: 'b',
      baseBare: 'file',
      extSimple: '.txt',
      extMulti: '.gz',
      extDotfile: '',
      extNone: '',
      extDotInDir: '',
      extTrailingDot: '.',
      absRoot: true,
      absRelative: false,
      absDot: false,
      absEmpty: false,
    })
  })
})

// Every action src/io/impl/web.ts wires to `unsupported(...)` / `unsupportedFlow(...)`.
const UNSUPPORTED_ACTIONS: string[] = [
  'encrypt',
  'decrypt',
  'generateKeyPair',
  'sign',
  'verify',
  'writeFlow',
  'read',
  'readText',
  'write',
  'append',
  'copy',
  'rename',
  'rm',
  'exists',
  'stat',
  'lstat',
  'readdir',
  'ensureDir',
  'ensureFile',
  'emptyDir',
  'walk',
  'chmod',
  'symlink',
  'readlink',
  'exec',
  'spawn',
  'tcpListen',
  'tcpConnect',
  'udpBind',
  'ip',
  'tmpdir',
]

const UNSUPPORTED_FLOWS: string[] = ['readFlow', 'watch']

describe('WebIO unsupported actions', () => {
  it.each(UNSUPPORTED_ACTIONS)('%s fails std:io.unsupported', async name => {
    const outcome = await run(function* () {
      yield* WebIO.use()
      const action = (IO.actions as AnyType)[name] as (...args: AnyType[]) => AnyType
      const result = yield* attempt(() => action('/x', '/y'))
      return isFailure(result) ? [result.error, result.message] : 'no-failure'
    })

    expect(unwrap(outcome)).toEqual([
      IOErrors.Unsupported,
      `IO.${name} is not available in a web environment`,
    ])
  })

  it.each(UNSUPPORTED_FLOWS)('%s fails std:io.unsupported on subscribe', async name => {
    const outcome = await run(function* () {
      yield* WebIO.use()
      const flowOf = (IO.actions as AnyType)[name] as (...args: AnyType[]) => AnyType
      const result = yield* attempt(() => flowOf('/x'))
      return isFailure(result) ? result.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe(IOErrors.Unsupported)
  })

  it('the table covers every unsupported slot in web.ts', () => {
    // guard against the table drifting from the impl: count the `unsupported(` wirings in the source
    const source = readFileSync(join(import.meta.dir, '../../src/io/impl/web.ts'), 'utf8')
    const wired = [...source.matchAll(/^\s+(\w+): unsupported\('(\w+)'\)/gmu)].map(m => m[2])
    const flows = [...source.matchAll(/^\s+(\w+): \(\) => unsupportedFlow\('(\w+)'\)/gmu)].map(
      m => m[2],
    )
    expect(wired.toSorted()).toEqual([...UNSUPPORTED_ACTIONS].toSorted())
    expect(flows.toSorted()).toEqual([...UNSUPPORTED_FLOWS].toSorted())
  })
})
