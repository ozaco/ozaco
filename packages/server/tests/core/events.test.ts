/**
 * `defineEvents` — the typed face of the event plane. Names and payloads are checked where they
 * are written; a subscriber sees the payload typed, and a malformed one is dropped rather than
 * handed on.
 */
import type { ServerDef } from 'server:core'
import { action, createServer, defineEvents, service } from 'server:core'
import { attempt, race, run, sleep } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { storage } from '../helpers'

const events = defineEvents({
  'todo.created': z.object({ id: z.string(), title: z.string() }),
  'media.uploaded': z.object({ id: z.string(), size: z.number().default(0) }),
})

const app = service('app', {
  create: action.mutation(
    { input: z.object({ title: z.string() }), output: z.object({ ok: z.boolean() }) },
    function* ({ input }) {
      yield* events.emit('todo.created', { id: 'a1', title: input.title })
      return { ok: true }
    },
  ),
})

describe('core — defineEvents', () => {
  it('names the events once: emit validates, on() types and filters', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [app] })

        const feed = yield* events.on('todo.created')
        yield* server.call(app, 'create', { title: 'typed' })

        const step = yield* race([
          feed.next(),
          (function* () {
            yield* sleep(1000)
            return { done: true as const, value: undefined }
          })(),
        ])

        expect(step.done).toBe(false)

        // typed end to end — no cast on the payload
        const payload = (step as { value: { id: string; title: string } }).value
        expect(payload).toEqual({ id: 'a1', title: 'typed' })

        // the schema's defaults apply on the way out
        const uploads = yield* events.on('media.uploaded')
        yield* events.emit('media.uploaded', { id: 'u1' })

        const upload = yield* race([
          uploads.next(),
          (function* () {
            yield* sleep(1000)
            return { done: true as const, value: undefined }
          })(),
        ])
        expect((upload as AnyType).value).toEqual({ id: 'u1', size: 0 })

        yield* server.stop()
      }),
    )
  })

  it('a malformed payload fails at the emitter, and is dropped (reported) at the subscriber', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const failures: AnyType[] = []

        const Spy = definePlugin<ServerDef.PluginContext, []>({
          name: 'spy',
          version: '0',
          *setup() {
            return {
              hooks: {
                name: 'spy',
                *observe(event) {
                  if (event.t === 'failure') {
                    failures.push(event.row)
                  }
                },
              },
            }
          },
        }).build()

        const server = yield* createServer({ services: [app], plugins: [Spy] })

        // the emitter is where a bad payload is still fixable
        const bad = yield* attempt(() => events.emit('todo.created', { id: 'a1' } as AnyType))
        expect((bad as AnyType).error).toBe('server.validation')

        // one published off the typed plane (the raw wire) with the wrong shape is DROPPED
        const feed = yield* events.on('todo.created')
        yield* server.emit('todo.created', { nope: true })
        yield* server.call(app, 'create', { title: 'good one' })

        const step = yield* race([
          feed.next(),
          (function* () {
            yield* sleep(1000)
            return { done: true as const, value: undefined }
          })(),
        ])

        // the subscriber skipped the bad one and got the good one
        expect((step as AnyType).value).toEqual({ id: 'a1', title: 'good one' })
        expect(failures.some(row => row.where === 'event:todo.created')).toBe(true)

        yield* server.stop()
      }),
    )
  })
})
