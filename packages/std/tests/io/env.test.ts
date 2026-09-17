/**
 * `IO.actions.cwd()` / `IO.actions.homeDir()`: the process values on Bun and Node; in a browser
 * the working directory is the page's directory and there is no home.
 */
import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'
import { WebIO } from 'std:io/impl/web'

import { readWebCwd } from '../../src/io/internal/env'

const fakeGlobals = (value: object) => value as unknown as typeof globalThis

describe('IO — cwd and homeDir', () => {
  it.each([
    ['BunIO', BunIO],
    ['NodeIO', NodeIO],
  ] as const)('%s answers the process cwd and the OS home', async (_label, impl) => {
    const outcome = await run(function* () {
      yield* impl.use()
      return { cwd: yield* IO.actions.cwd(), home: yield* IO.actions.homeDir() }
    })

    expect(unwrap(outcome)).toEqual({ cwd: process.cwd(), home: homedir() })
  })

  it('WebIO: cwd is the page directory (/ without a location), homeDir is unsupported', async () => {
    expect(readWebCwd(fakeGlobals({ location: { pathname: '/app/settings/index.html' } }))).toBe(
      '/app/settings/',
    )
    expect(readWebCwd(fakeGlobals({ location: { pathname: '/' } }))).toBe('/')
    expect(readWebCwd(fakeGlobals({}))).toBe('/')

    const outcome = await run(function* () {
      yield* WebIO.use()
      const home = yield* attempt(() => IO.actions.homeDir())
      return { cwd: yield* IO.actions.cwd(), home: isFailure(home) ? home.error : home.value }
    })

    expect(unwrap(outcome)).toEqual({ cwd: '/', home: 'std:io.unsupported' })
  })
})
