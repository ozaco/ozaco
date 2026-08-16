import type { Flow } from 'std:effect'
import { attempt, createQueue, run, spawn, until } from 'std:effect'
import { IO, IO_FLAGS } from 'std:io'
import { install } from 'std:plugin'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { BunIO } from 'std:io/impl/bun'

import { fromReadable } from '../../src/io/internal/from-readable'

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

/** A pre-buffered single-subscriber byte flow (mirrors the queueFlow pattern in io/internal/net.ts). */
const flowOf = (...chunks: string[]): Flow<Uint8Array, unknown> => {
  const queue = createQueue<Uint8Array, unknown>()
  for (const chunk of chunks) {
    queue.add(encoder.encode(chunk))
  }
  queue.close(true)
  return {
    *[Symbol.iterator]() {
      return queue
    },
  }
}

describe('readFlow / writeFlow', () => {
  it('readFlow streams the file and closes with true', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const file = join(dir, 'data.txt')
        yield* IO.actions.write(file, 'stream-payload')

        const source = yield* IO.actions.readFlow(file)
        let text = ''
        while (true) {
          const item = yield* source.next()
          if (item.done) {
            return { text, close: item.value }
          }
          text += decoder.decode(item.value)
        }
      })

      expect(unwrap(outcome)).toEqual({ text: 'stream-payload', close: true })
    })
  })

  it('readFlow of a missing file closes with a Failure, not a clean end', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const source = yield* IO.actions.readFlow(join(dir, 'missing.txt'))
        const first = yield* source.next()

        return {
          done: first.done === true,
          closeIsFailure: first.done === true && isFailure(first.value),
        }
      })

      expect(unwrap(outcome)).toEqual({ done: true, closeIsFailure: true })
    })
  })

  it('writeFlow drains a flow into the file', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const file = join(dir, 'out.txt')
        yield* IO.actions.writeFlow(file, flowOf('hello ', 'flow ', 'world'))

        return yield* IO.actions.readText(file)
      })

      expect(unwrap(outcome)).toBe('hello flow world')
    })
  })

  it('writeFlow with EXCLUSIVE fails on an existing file and leaves it untouched', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const file = join(dir, 'guarded.txt')
        yield* IO.actions.write(file, 'already')

        const denied = yield* attempt(() =>
          IO.actions.writeFlow(file, flowOf('overwrite'), { flags: IO_FLAGS.EXCLUSIVE }),
        )

        return {
          deniedFailed: isFailure(denied),
          text: yield* IO.actions.readText(file),
        }
      })

      expect(unwrap(outcome)).toEqual({ deniedFailed: true, text: 'already' })
    })
  })

  it('readFlow feeds writeFlow: a whole-file streaming copy', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const src = join(dir, 'src.txt')
        const dest = join(dir, 'dest.txt')
        yield* IO.actions.write(src, 'copy-me-around')

        const reading = yield* IO.actions.readFlow(src)
        yield* IO.actions.writeFlow(dest, {
          *[Symbol.iterator]() {
            return reading
          },
        })

        return yield* IO.actions.readText(dest)
      })

      expect(unwrap(outcome)).toBe('copy-me-around')
    })
  })

  it('writeFlow surfaces a Failure close value from its source instead of succeeding', async () => {
    await withTempDir(async dir => {
      const outcome = await run(function* () {
        yield* install(BunIO)

        const path = join(dir, 'truncated.txt')
        const queue = createQueue<Uint8Array, unknown>()
        queue.add(encoder.encode('partial-'))
        queue.close(fail('upstream-died', 'source truncated mid-flow'))

        return yield* IO.actions.writeFlow(path, {
          *[Symbol.iterator]() {
            return queue
          },
        })
      })

      // per the FlowClose contract a Failure close means truncation — writeFlow must NOT report
      // success for the partial file it wrote
      expect(isFailure(outcome)).toBe(true)
      if (isFailure(outcome)) {
        expect(String(outcome.error)).toBe('upstream-died')
        expect(outcome.causes).toContain('write-stream')
      }
    })
  })
})

describe('fromReadable', () => {
  it('adapts a web-reader-like source: bytes, clean close, released lock', async () => {
    const parts = [encoder.encode('ab'), encoder.encode('cd')]
    let released = false

    const reader = {
      read: () =>
        Promise.resolve(
          parts.length > 0
            ? { done: false as const, value: parts.shift()! }
            : { done: true as const, value: undefined },
        ),
      cancel: () => Promise.resolve(),
      releaseLock: () => {
        released = true
      },
    }

    const outcome = await run(function* () {
      const source = yield* fromReadable(reader)
      let text = ''
      while (true) {
        const item = yield* source.next()
        if (item.done) {
          return { text, close: item.value }
        }
        text += decoder.decode(item.value)
      }
    })

    expect(unwrap(outcome)).toEqual({ text: 'abcd', close: true })
    expect(released).toBe(true)
  })

  it('adapts a Node Readable: bytes arrive, close is true', async () => {
    const readable = Readable.from([Buffer.from('yaprak'), Buffer.from('-dere')])

    const outcome = await run(function* () {
      const source = yield* fromReadable(readable)
      let text = ''
      while (true) {
        const item = yield* source.next()
        if (item.done) {
          return { text, close: item.value }
        }
        text += decoder.decode(item.value)
      }
    })

    expect(unwrap(outcome)).toEqual({ text: 'yaprak-dere', close: true })
  })

  it('a Node Readable error becomes the Failure close value', async () => {
    const readable = new Readable({
      read() {
        this.destroy(new Error('mid-stream boom'))
      },
    })

    const outcome = await run(function* () {
      const source = yield* fromReadable(readable)
      const first = yield* source.next()

      return {
        done: first.done === true,
        closeIsFailure: first.done === true && isFailure(first.value),
      }
    })

    expect(unwrap(outcome)).toEqual({ done: true, closeIsFailure: true })
  })
})

describe('toReadable', () => {
  it('round-trips a flow into a consumable ReadableStream', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const { readable, pump } = yield* IO.actions.toReadable(flowOf('web ', 'stream'))

      const body = yield* spawn(() => until(new Response(readable).arrayBuffer()))
      yield* pump

      return decoder.decode(new Uint8Array(yield* body))
    })

    expect(unwrap(outcome)).toBe('web stream')
  })

  it('a Failure close value errors the stream instead of ending it cleanly', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      const queue = createQueue<Uint8Array, unknown>()
      queue.add(encoder.encode('partial'))
      queue.close(fail('flow-truncated', 'source died mid-stream'))

      const { readable, pump } = yield* IO.actions.toReadable({
        *[Symbol.iterator]() {
          return queue
        },
      })

      const body = yield* spawn(() => attempt(() => until(new Response(readable).arrayBuffer())))
      yield* pump

      return isFailure(yield* body)
    })

    expect(unwrap(outcome)).toBe(true)
  })

  it('consumer cancel ends the pump even while the source is idle', async () => {
    const outcome = await run(function* () {
      yield* install(BunIO)

      // one chunk, never closed — without cancel the pump would park forever
      const queue = createQueue<Uint8Array, unknown>()
      queue.add(encoder.encode('only'))

      const { readable, pump } = yield* IO.actions.toReadable({
        *[Symbol.iterator]() {
          return queue
        },
      })

      const reader = readable.getReader()
      yield* spawn(function* () {
        yield* until(reader.read())
        yield* until(reader.cancel())
      })

      yield* pump
      return 'pump-returned'
    })

    expect(unwrap(outcome)).toBe('pump-returned')
  })
})
