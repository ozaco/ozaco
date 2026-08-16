import { CodecErrors } from 'std:codec'
import { Config } from 'std:config'
import { run } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'

const makeRoot = () => mkdtemp(join(tmpdir(), 'ozaco-config-'))

describe('config error paths', () => {
  it('a malformed config file fails the load with a Result, not a throw', async () => {
    const root = await makeRoot()
    try {
      await writeFile(join(root, '.cfgspec.json'), '{ this is not json')

      const outcome = await run(function* () {
        yield* install(BunIO)
        yield* install(JsonCodec)
        yield* install(Config, { codec: JsonCodec, name: 'cfgspec', cwd: root, home: root })
        yield* Config.actions.load()
        return 'unreachable'
      })

      expect(isFailure(outcome)).toBe(true)
      if (isFailure(outcome)) {
        expect(outcome.error).toBe(CodecErrors.Parse)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('actions fail with missing-action when the required plugins are absent', async () => {
    // no Config installed at all
    const withoutConfig = await run(function* () {
      return yield* Config.actions.get('anything')
    })

    expect(isFailure(withoutConfig)).toBe(true)
    if (isFailure(withoutConfig)) {
      expect(withoutConfig.error).toBe('missing-action')
    }

    // Config installed without an IO impl: setup cannot even resolve the working path
    const withoutIo = await run(function* () {
      yield* install(JsonCodec)
      yield* install(Config, { codec: JsonCodec, name: 'cfgspec', cwd: '/tmp', home: '/tmp' })
      return 'unreachable'
    })

    expect(isFailure(withoutIo)).toBe(true)
    if (isFailure(withoutIo)) {
      expect(withoutIo.error).toBe('missing-action')
    }
  })
})
