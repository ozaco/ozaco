import { createClient } from 'client:core'
import { run, sleep } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import type { Api } from './fixture'
import { boot } from './fixture'

// `client.$realtime`: idle → open with a watch → reconnecting when the server goes away.

interface Note {
  readonly _id: string
  readonly title: string
}

describe('client — realtime status', () => {
  it('reports idle, open, reconnecting and tells its subscribers', async () => {
    unwrap(
      await run(function* () {
        const { url, server } = yield* boot()
        const client = yield* createClient<Api>({ url })
        const seen: string[] = []
        const waitFor = function* (status: string) {
          for (let round = 0; round < 100 && client.$realtime.status() !== status; round += 1) {
            yield* sleep(20)
          }

          return client.$realtime.status()
        }

        client.$realtime.subscribe(status => {
          seen.push(status)
        })

        expect(client.$realtime.status()).toBe('idle')

        const notes = client.$collection<Note>('notes', { limit: 5 })

        yield* notes.load()

        expect(yield* waitFor('open')).toBe('open')

        yield* server.stop()

        expect(yield* waitFor('reconnecting')).toBe('reconnecting')

        notes.stop()

        expect(['idle', 'down']).toContain(yield* waitFor('idle'))
        expect(seen).toContain('open')
        expect(seen).toContain('reconnecting')
      }),
    )
  })
})
