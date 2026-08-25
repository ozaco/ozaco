import type { Operation } from 'std:effect'
import { run, until } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { fail, unwrap } from 'std:result'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'
import { FileTransport } from 'std:logger/transport/file'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ozaco-logger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('file transport', () => {
  it('writes NDJSON records end-to-end through the IO layer', async () => {
    const path = join(dir, 'app.log')

    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(BunIO)
        yield* install(DefaultLogger, { timestamp: () => 1111 })
        yield* install(FileTransport, { path })

        yield* Logger.actions.info('hello', { a: 1 })
        yield* Logger.actions.error('request failed', fail('boom', 'why'))
      }),
    )

    const raw = await readFile(path, 'utf8')
    const lines = raw.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      level: LogLevel.info,
      time: 1111,
      msg: 'hello',
      a: 1,
    })
    // toMatchObject: the failure-payload data leak (see records.test.ts todo) adds extra keys
    expect(JSON.parse(lines[1]!)).toMatchObject({
      level: LogLevel.error,
      time: 1111,
      msg: 'request failed',
      err: 'boom: why',
    })
  })

  it('bufferSize batches writes; flush drains the remainder', async () => {
    const path = join(dir, 'buffered.log')
    const countLines = (text: string) => (text === '' ? 0 : text.trimEnd().split('\n').length)

    const outcome = await run(function* () {
      yield* install(JsonCodec)
      yield* install(BunIO)
      yield* install(DefaultLogger)
      yield* install(FileTransport, { path, bufferSize: 3 })

      // setup already ensured the (empty) file exists
      const afterInstall = yield* until(readFile(path, 'utf8'))

      yield* Logger.actions.info('one')
      yield* Logger.actions.info('two')
      const beforeThreshold = yield* until(readFile(path, 'utf8'))

      yield* Logger.actions.info('three')
      const afterThreshold = yield* until(readFile(path, 'utf8'))

      yield* Logger.actions.info('four')
      yield* Logger.actions.flush()
      const afterFlush = yield* until(readFile(path, 'utf8'))

      return {
        afterInstall,
        beforeThreshold,
        afterThreshold: countLines(afterThreshold),
        afterFlush: countLines(afterFlush),
      }
    })

    expect(unwrap(outcome)).toEqual({
      afterInstall: '',
      beforeThreshold: '',
      afterThreshold: 3,
      afterFlush: 4,
    })
  })

  it('close drains anything left in the buffer', async () => {
    const path = join(dir, 'closed.log')

    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(BunIO)
        yield* install(DefaultLogger)
        yield* install(FileTransport, { path, bufferSize: 10 })

        yield* Logger.actions.info('pending')
        yield* Logger.actions.close()
      }),
    )

    const raw = await readFile(path, 'utf8')
    const lines = raw.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'pending' })
  })

  it('applies its own level threshold independently of the logger', async () => {
    const path = join(dir, 'filtered.log')

    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(BunIO)
        yield* install(DefaultLogger)
        yield* install(FileTransport, { path, level: LogLevel.warn })

        yield* Logger.actions.info('skipped by the transport')
        yield* Logger.actions.warn('written')
      }),
    )

    const raw = await readFile(path, 'utf8')
    const lines = raw.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: LogLevel.warn, msg: 'written' })
  })

  it('honors custom msgKey/errorKey in the serialized record', async () => {
    const path = join(dir, 'keys.log')

    unwrap(
      await run(function* () {
        yield* install(JsonCodec)
        yield* install(BunIO)
        yield* install(DefaultLogger)
        yield* install(FileTransport, { path, msgKey: 'note', errorKey: 'problem' })

        yield* Logger.actions.error('bad', fail('boom', 'why'))
      }),
    )

    const raw = await readFile(path, 'utf8')
    const record = JSON.parse(raw.trimEnd())
    expect(record).toMatchObject({ note: 'bad', problem: 'boom: why' })
    expect(record.msg).toBeUndefined()
  })

  it('a custom format bypasses the NDJSON serializer entirely', async () => {
    const path = join(dir, 'custom.log')
    const lineFormat = function* (entry: LoggerDef.Entry): Operation<string> {
      return `${entry.level}|${entry.msg}\n`
    }

    unwrap(
      await run(function* () {
        // no JsonCodec on purpose — the custom format must not need it
        yield* install(BunIO)
        yield* install(DefaultLogger)
        yield* install(FileTransport, { path, format: lineFormat })

        yield* Logger.actions.info('custom')
      }),
    )

    expect(await readFile(path, 'utf8')).toBe(`${LogLevel.info}|custom\n`)
  })
})
