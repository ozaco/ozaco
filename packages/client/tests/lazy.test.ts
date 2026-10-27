import { lazyClient } from 'client:core'
import { run, sleep, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'

// `lazyClient(options)`: the handle at once; every use waits for the client by itself.

interface Note {
  readonly _id: string
  readonly title: string
}

describe('client — lazy', () => {
  it('answers synchronously; calls and a collection made before the client exists work once it does', async () => {
    unwrap(
      await run(function* () {
        const { url } = yield* boot()
        const client = lazyClient<Api>({ url })

        // usable before anything was fetched
        expect(client.$session.status()).toBe('anonymous')
        expect(client.$realtime.status()).toBe('idle')
        expect(client.$lastRequestId()).toBeNull()

        const notes = client.$collection<Note>('notes', { limit: 2 })

        expect(notes.rows()).toEqual([])

        const created = unwrap(
          yield* until(client.notes.create({ title: 'lazy', done: false } as AnyType)),
        ) as Note

        expect(created.title).toBe('lazy')

        const rows = unwrap(yield* until(notes.load()))

        expect(rows.map(row => row.title)).toEqual(['lazy'])
        expect(notes.rows().map(row => row.title)).toEqual(['lazy'])

        const handle = yield* until(client.$ready)

        expect(handle.$lastRequestId()).toBeTruthy()
        expect(client.$lastRequestId()).toBe(handle.$lastRequestId())

        // the collection's watch opens its socket in the background
        for (let round = 0; round < 100 && client.$realtime.status() !== 'open'; round += 1) {
          yield* sleep(20)
        }

        expect(client.$realtime.status()).toBe('open')

        notes.stop()
        yield* until(client.$close())
      }),
    )
  })
})
