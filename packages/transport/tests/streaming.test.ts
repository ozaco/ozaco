/**
 * BIG payloads — 100 MB, 1 GB, 10 GB — ride the stream plane, and the point of that plane is
 * that neither side ever holds the payload: `writable` slices every write into frames of at
 * most `frameBytes` (clamped by what the backend accepts) and the consumer's pulls become lane
 * credit, so a transfer of ANY size keeps `credit * frameBytes` in memory and no more. Each
 * `read()` hands back exactly ONE lane frame, so the reader also sees what the wire carried.
 *
 * Size is env-scalable: `TRANSPORT_BIG_BYTES=10737418240 bun test tests/streaming.test.ts`
 * runs the same transfer at 10 GB.
 */
import type { Operation } from 'std:effect'
import { fork, run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { Transport } from 'transport:core'
import { MemoryTransport } from 'transport:impl/memory'

const MB = 1024 * 1024

/** How much to carry end to end. 512 MB by default — big enough that materializing it would
 * stand out in RSS, small enough to stay a fast unit test. */
const TOTAL = Number(process.env['TRANSPORT_BIG_BYTES'] ?? 512 * MB)

/** The source repeats this block, so every byte has a known expected value at its offset — the
 * receiver verifies with native memcmp instead of walking bytes in JS. */
const BLOCK = new Uint8Array(MB)
crypto.getRandomValues(BLOCK)

/** RSS a transfer may grow by, whatever its size — generous room over the ~110-140 MB the
 * frames, the write block and GC churn actually cost. */
const BOUNDED_MB = 256

const rssMb = (): number => Math.round(process.memoryUsage.rss() / MB)

const unique = (prefix: string): string => `${prefix}.${crypto.randomUUID().slice(0, 8)}`

/** Byte-exact verification against the repeating block, boundary-independent: every arriving
 * frame is compared to the block slice its offset points at. */
const verifier = () => {
  let at = 0
  let intact = true

  return {
    get total() {
      return at
    },
    get intact() {
      return intact
    },
    push(chunk: Uint8Array) {
      let index = 0

      while (index < chunk.length) {
        const into = at % BLOCK.length
        const take = Math.min(chunk.length - index, BLOCK.length - into)
        const seen = Buffer.from(chunk.buffer, chunk.byteOffset + index, take)
        const want = Buffer.from(BLOCK.buffer, BLOCK.byteOffset + into, take)

        if (Buffer.compare(seen, want) !== 0) {
          intact = false

          return
        }

        index += take
        at += take
      }
    },
  }
}

/** Drain a lane into the verifier, reporting what the wire actually carried. */
const drain = (
  topic: string,
  options: { credit: number; frameBytes: number },
  check?: ReturnType<typeof verifier>,
): Operation<{ frames: number; largest: number; bytes: number; peakMb: number }> =>
  (function* () {
    const readable = yield* Transport.actions.readable(topic, options)

    return yield* until(
      (async () => {
        const stream = readable.getReader()
        let frames = 0
        let largest = 0
        let bytes = 0
        let peakMb = 0

        for (;;) {
          // oxlint-disable-next-line no-await-in-loop
          const step = await stream.read()

          if (step.done) {
            break
          }

          frames += 1
          bytes += step.value.length
          largest = Math.max(largest, step.value.length)
          peakMb = Math.max(peakMb, rssMb())
          check?.push(step.value)
        }

        return { frames, largest, bytes, peakMb }
      })(),
    )
  })()

/** Write `total` bytes as `writeSize` blocks — one buffer reused, so the SOURCE is generated,
 * never materialized either. */
const feed = (
  topic: string,
  options: { credit: number; frameBytes: number; total: number; writeSize: number },
): Operation<void> =>
  (function* () {
    const { total, writeSize } = options
    const writable = yield* Transport.actions.writable(topic, options)
    const block = new Uint8Array(writeSize)

    for (let at = 0; at < writeSize; at += BLOCK.length) {
      block.set(BLOCK.subarray(0, Math.min(BLOCK.length, writeSize - at)), at)
    }

    yield* until(
      (async () => {
        const writer = writable.getWriter()

        for (let sent = 0; sent < total; sent += writeSize) {
          // each write resolves once its frames are on the wire: this loop IS the backpressure
          // oxlint-disable-next-line no-await-in-loop
          await writer.write(block.subarray(0, Math.min(writeSize, total - sent)))
        }

        await writer.close()
      })(),
    )
  })()

describe('transport — big payloads stream', () => {
  it(`carries ${Math.round(TOTAL / MB)}MB end to end without ever holding it`, async () => {
    // written in 8 MB blocks: the caller's write size must NOT decide what the wire carries
    const options = { credit: 8, frameBytes: 256 * 1024 }

    const outcome = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryTransport.use({ prefix: 'big' })
        const topic = unique('stream')
        const check = verifier()
        const before = rssMb()
        const reader = yield* fork(() => drain(topic, options, check))

        yield* feed(topic, { ...options, total: TOTAL, writeSize: 8 * MB })
        const seen = yield* reader

        return { ...seen, total: check.total, intact: check.intact, growth: seen.peakMb - before }
      }),
    )

    expect(outcome.total).toBe(TOTAL)
    expect(outcome.intact).toBe(true)
    // the 8 MB writes never travelled as 8 MB — every frame stayed inside the budget
    expect(outcome.largest).toBeLessThanOrEqual(options.frameBytes)
    expect(outcome.frames).toBe(Math.ceil(TOTAL / options.frameBytes))
    // what a transfer holds is `credit * frameBytes` plus one write block — a FIXED cost, so
    // this bound does not scale with TOTAL: measured ~108 MB of RSS growth at 512 MB and
    // ~136 MB at 10 GB (the payload itself never exists anywhere)
    expect(outcome.growth).toBeLessThan(BOUNDED_MB)
  }, 300_000)

  it('slices ONE huge write — the wire never sees a frame bigger than the budget', async () => {
    const options = { credit: 4, frameBytes: 64 * 1024 }
    const written = 32 * MB

    const seen = unwrap(
      await run(function* () {
        yield* BunIO.use()
        yield* MemoryTransport.use({ prefix: 'big' })
        const topic = unique('huge')
        const check = verifier()
        const reader = yield* fork(() => drain(topic, options, check))

        // ONE write, 32 MB of it
        yield* feed(topic, { ...options, total: written, writeSize: written })

        return { ...(yield* reader), intact: check.intact }
      }),
    )

    expect(seen.bytes).toBe(written)
    expect(seen.intact).toBe(true)
    expect(seen.largest).toBeLessThanOrEqual(options.frameBytes)
    expect(seen.frames).toBe(written / options.frameBytes)
  }, 120_000)

  it('clamps frames to the backend payload limit — the stream plane never needs chunking', async () => {
    const limit = 64 * 1024
    // asks for 1 MB frames: the backend limit wins, minus the allowance chunking would need
    const options = { credit: 4, frameBytes: MB }

    const seen = unwrap(
      await run(function* () {
        yield* BunIO.use()
        // a backend as strict as NATS: a frame over the limit would have to be split by the
        // driver and reassembled WHOLE on the far side — the budget keeps the lane under it
        yield* MemoryTransport.use({ prefix: 'big', maxPayloadBytes: limit })
        const topic = unique('clamped')
        const check = verifier()
        const reader = yield* fork(() => drain(topic, options, check))

        yield* feed(topic, { ...options, total: 8 * MB, writeSize: 2 * MB })

        return { ...(yield* reader), intact: check.intact }
      }),
    )

    expect(seen.bytes).toBe(8 * MB)
    expect(seen.intact).toBe(true)
    expect(seen.largest).toBeLessThanOrEqual(limit)
    // and it really did travel in many small frames, not two reassembled 2 MB blocks
    expect(seen.frames).toBeGreaterThanOrEqual((8 * MB) / limit)
  }, 120_000)
})
