import type { Wire } from 'server:core'
import {
  createMultistreamAssembler,
  inputLaneOf,
  isInputLane,
  planeOfLane,
  pumpMultistream,
} from 'server:core'
import { each } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { runResult, runScoped } from '../helpers'

const drainMultistream = function* (assembler: ReturnType<typeof createMultistreamAssembler>) {
  const seen: { kind: string; name?: string; size?: number; value?: string }[] = []

  for (const part of yield* each(assembler.multistream.parts)) {
    if (part.kind === 'field') {
      seen.push({ kind: 'field', name: part.name, value: part.value })
    } else {
      let size = 0

      for (const chunk of yield* each(part.data)) {
        size += chunk.byteLength
        yield* each.next()
      }

      seen.push({ kind: 'file', name: part.filename, size })
    }

    yield* each.next()
  }

  return seen
}

describe('lane helpers', () => {
  it('names and classifies input lanes', () => {
    expect(inputLaneOf('multistream')).toBe('in:multistream')
    expect(isInputLane('in:stream')).toBe(true)
    expect(isInputLane('0')).toBe(false)
    expect(planeOfLane('in:multistream')).toBe('multistream')
  })

  it('pump → frames → assembler round-trips a multistream verbatim', async () => {
    const result = await runScoped(function* () {
      // build a source multistream out of an assembler (frames in)
      const source = createMultistreamAssembler()

      const inbound: Wire.PartFrame[] = [
        { p: 'field', name: 'note', value: 'hello' },
        { p: 'file', name: 'doc', filename: 'a.bin', contentType: 'application/x' },
        { p: 'chunk', data: new Uint8Array(10) },
        { p: 'chunk', data: new Uint8Array(6) },
        { p: 'file-end' },
        { p: 'field', name: 'after', value: 'tail' },
      ]

      for (const frame of inbound) {
        source.push(frame)
      }

      source.end()

      // pump it through the shared frame vocabulary into a second assembler (the remote side)
      const remote = createMultistreamAssembler()
      const frames: Wire.PartFrame[] = []

      yield* pumpMultistream(source.multistream, frame => ({
        *[Symbol.iterator]() {
          frames.push(frame)
          remote.push(frame)
        },
      }))
      remote.end()

      const seen = yield* drainMultistream(remote)

      return { frames: frames.map(frame => frame.p), seen }
    })

    expect(result.frames).toEqual(['field', 'file', 'chunk', 'chunk', 'file-end', 'field'])
    expect(result.seen).toEqual([
      { kind: 'field', name: 'note', value: 'hello' },
      { kind: 'file', name: 'a.bin', size: 16 },
      { kind: 'field', name: 'after', value: 'tail' },
    ])
  })

  it('a failure close re-raises in the consuming handler', async () => {
    const outcome = await runResult(function* () {
      const remote = createMultistreamAssembler()

      const inbound: Wire.PartFrame[] = [
        { p: 'file', name: 'doc', filename: 'b.bin', contentType: 'application/x' },
        { p: 'chunk', data: new Uint8Array(4) },
      ]

      for (const frame of inbound) {
        remote.push(frame)
      }

      remote.end(fail('lane.broken', 'producer died') as Result.Failure<unknown>)

      yield* drainMultistream(remote)
    })

    expect(outcome).toMatchObject({ error: 'lane.broken' })
  })
})
