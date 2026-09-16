/**
 * `markContextAsSnapshot`: a child scope takes a COPY of the value when it is created — later
 * `set`s in the parent and mutations on either side stay on their side. A plain context is
 * inherited live through the prototype chain, as before.
 */
import { createContext, markContextAsSnapshot, run, scoped, sleep, spawn } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const plain = createContext<{ n: number }>('test:snapshot:plain')
const snap = markContextAsSnapshot(createContext<{ n: number }>('test:snapshot:snap'))
const label = markContextAsSnapshot(createContext<string>('test:snapshot:label'))

describe('snapshot contexts', () => {
  it('a mutation inside a child scope does not reach the parent (a live context does)', async () => {
    unwrap(
      await run(function* () {
        yield* plain.set({ n: 0 })
        yield* snap.set({ n: 0 })

        yield* scoped(function* () {
          ;(yield* plain.expect()).n += 1
          ;(yield* snap.expect()).n += 1
          // the child reads its own copy
          expect((yield* snap.expect()).n).toBe(1)
        })

        expect((yield* plain.expect()).n).toBe(1)
        expect((yield* snap.expect()).n).toBe(0)
      }),
    )
  })

  it('a task forked earlier keeps the value it was forked with; a live context sees the new one', async () => {
    unwrap(
      await run(function* () {
        yield* plain.set({ n: 1 })
        yield* snap.set({ n: 1 })
        yield* label.set('before')

        const child = yield* spawn(function* () {
          yield* sleep(5)
          return {
            plain: (yield* plain.expect()).n,
            snap: (yield* snap.expect()).n,
            label: yield* label.expect(),
          }
        })

        yield* plain.set({ n: 2 })
        yield* snap.set({ n: 2 })
        yield* label.set('after')

        expect(yield* child).toEqual({ plain: 2, snap: 1, label: 'before' })
      }),
    )
  })

  it('a child that sets its own value shadows the snapshot, and the parent is untouched', async () => {
    unwrap(
      await run(function* () {
        yield* snap.set({ n: 10 })

        yield* scoped(function* () {
          yield* snap.set({ n: 20 })
          expect((yield* snap.expect()).n).toBe(20)
        })

        expect((yield* snap.expect()).n).toBe(10)
      }),
    )
  })

  it('an unset snapshot context stays unset in the child', async () => {
    const empty = markContextAsSnapshot(createContext<{ n: number }>('test:snapshot:empty'))

    unwrap(
      await run(function* () {
        yield* scoped(function* () {
          expect(yield* empty.get()).toBeUndefined()
        })
      }),
    )
  })
})
