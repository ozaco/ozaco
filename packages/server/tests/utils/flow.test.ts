import {
  batchFlow,
  collectFlow,
  drainFlow,
  filterFlow,
  mapFlow,
  pipeFlow,
  tapFlow,
} from 'server:utils'
import type { Flow } from 'std:effect'
import { call, createChannel, fork, sleep } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { runResult, runScoped } from '../helpers'

/** A re-subscribable flow emitting `items` then closing with `close`. */
const flowOf = <T, TClose>(items: readonly T[], close: TClose): Flow<T, TClose> => ({
  *[Symbol.iterator]() {
    let index = 0
    return {
      *next() {
        if (index < items.length) {
          const value = items[index]!
          index += 1
          return { done: false, value } as IteratorResult<T, TClose>
        }
        return { done: true, value: close } as IteratorResult<T, TClose>
      },
    }
  },
})

describe('pipeFlow + operators', () => {
  it('composes operators left-to-right', async () => {
    const flow = pipeFlow(
      flowOf([1, 2, 3, 4, 5, 6], 'closed'),
      filterFlow((value: number) => value % 2 === 0),
      mapFlow((value: number) => value * 10),
    )

    const items = await runScoped(() => collectFlow(flow))
    expect(items).toEqual([20, 40, 60])
  })

  it('operator callbacks may return operations', async () => {
    const flow = pipeFlow(
      flowOf([1, 2, 3], undefined),
      mapFlow<number, number>(value => call(() => value + 1)),
      filterFlow<number>(value => call(() => value > 2)),
    )

    const items = await runScoped(() => collectFlow(flow))
    expect(items).toEqual([3, 4])
  })

  it('tapFlow observes items without changing them', async () => {
    const seen: number[] = []
    const flow = pipeFlow(
      flowOf([1, 2, 3], undefined),
      tapFlow((value: number) => {
        seen.push(value)
      }),
    )

    const items = await runScoped(() => collectFlow(flow))
    expect(items).toEqual([1, 2, 3])
    expect(seen).toEqual([1, 2, 3])
  })

  it('passes the close value through operators untouched', async () => {
    const flow = pipeFlow(
      flowOf([1, 2], 'the-close'),
      mapFlow((value: number) => value * 2),
      tapFlow(() => {}),
    )

    const close = await runScoped(() => drainFlow(flow))
    expect(close).toBe('the-close')
  })

  it('stays re-subscribable: every subscription replays from scratch', async () => {
    const flow = pipeFlow(
      flowOf([1, 2, 3], undefined),
      mapFlow((value: number) => value + 1),
    )

    const first = await runScoped(() => collectFlow(flow))
    const second = await runScoped(() => collectFlow(flow))
    expect(first).toEqual([2, 3, 4])
    expect(second).toEqual(first)
  })
})

describe('batchFlow', () => {
  it('partitions exactly by size and flushes the remainder before close', async () => {
    const flow = pipeFlow(flowOf([1, 2, 3, 4, 5, 6, 7], 'done'), batchFlow<number>({ size: 3 }))

    const batches = await runScoped(() => collectFlow(flow))
    expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]])
  })

  it('propagates the close value', async () => {
    const flow = pipeFlow(flowOf([1, 2, 3], 'batched-close'), batchFlow<number>({ size: 2 }))

    const close = await runScoped(() => drainFlow(flow))
    expect(close).toBe('batched-close')
  })

  it('flushes a partial batch once maxWaitMs elapses, losing no item', async () => {
    const batches = await runScoped(function* () {
      const channel = createChannel<number, string>()
      const flow = pipeFlow(channel, batchFlow<number>({ size: 10, maxWaitMs: 30 }))

      yield* fork(function* () {
        yield* sleep(10)
        yield* channel.send(1)
        yield* channel.send(2)
        yield* sleep(80)
        yield* channel.send(3)
        yield* channel.close('done')
      })

      return yield* collectFlow(flow)
    })

    expect(batches).toEqual([[1, 2], [3]])
  })
})

describe('drainFlow + collectFlow', () => {
  it('drainFlow consumes everything and returns the close value', async () => {
    const close = await runScoped(() => drainFlow(flowOf([1, 2, 3], 42)))
    expect(close).toBe(42)
  })

  it('drainFlow raises a Failure close value', async () => {
    const source = flowOf([1], fail('flow-close', 'source truncated'))

    const outcome = await runResult(() => drainFlow(source))
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('flow-close')
    }
  })

  it('collectFlow raises a Failure close value', async () => {
    const source = flowOf([1, 2], fail('boom', 'truncated'))

    const outcome = await runResult(() => collectFlow(source))
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('boom')
    }
  })
})
