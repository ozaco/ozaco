import { createClient } from 'client:core'
import { run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'

// `client.$collection(resource)`: pages and live frames as one ordered list.

interface Note {
  readonly _id: string
  readonly _created_at: number
  readonly title: string
  readonly done: boolean
}

describe('client — collection', () => {
  it('loads the first page, walks pages back with more(), merges live frames and removals', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = yield* createClient<Api>({ url })

        for (const title of ['one', 'two', 'three']) {
          yield* client.notes.create({ title, done: false } as AnyType)
        }

        const notes = client.$collection<Note>('notes', { limit: 2 })
        const changes = yield* notes.changes

        expect(notes.rows()).toEqual([])

        const first = yield* notes.load()

        expect(first.map(row => row.title)).toEqual(['three', 'two'])
        expect(notes.hasMore()).toBe(true)
        expect(((yield* changes.next()).value as Note[]).map(row => row.title)).toEqual([
          'three',
          'two',
        ])

        expect(yield* notes.more()).toBe(true)
        expect(notes.rows().map(row => row.title)).toEqual(['three', 'two', 'one'])
        expect(notes.hasMore()).toBe(false)
        expect(yield* notes.more()).toBe(false)
        yield* changes.next()

        // a write elsewhere reaches the list through the live window; its frames may arrive as
        // one delta or as a sync of the window — either way the newest row lands on top
        const created = (yield* client.notes.create({
          title: 'four',
          done: false,
        } as AnyType)) as Note

        for (;;) {
          const step = yield* changes.next()
          const titles = (step.value as Note[]).map(row => row.title)

          if (titles[0] === 'four') {
            expect(titles).toEqual(['four', 'three', 'two', 'one'])

            break
          }
        }

        yield* client.notes.remove({ id: created._id } as AnyType)

        for (;;) {
          const step = yield* changes.next()
          const titles = (step.value as Note[]).map(row => row.title)

          if (!titles.includes('four')) {
            expect(titles).toEqual(['three', 'two', 'one'])

            break
          }
        }

        notes.stop()
      }),
    )
  })
})
