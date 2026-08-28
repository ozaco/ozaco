/**
 * `serviceErrors` — a service's failure taxonomy declared once. The tag, its HTTP status and
 * the way to raise it come from the same object, so the `errors` map and the `fail()` call can
 * no longer drift (an undeclared tag answers 500, whatever the handler meant).
 */
import { action, createServer, serviceErrors, service } from 'server:core'
import { attempt, run, until } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

const media = serviceErrors('media', { 'not-found': 404, 'too-large': 413 })

describe('core — serviceErrors', () => {
  it('builds the tag, the status map and the failer from one declaration', () => {
    expect(media.notFound.tag).toBe('media.not-found')
    expect(media.tooLarge.tag).toBe('media.too-large')
    expect(media.statuses).toEqual({ 'media.not-found': 404, 'media.too-large': 413 })
  })

  it('the raised failure carries the tag, and the declared status reaches the wire', async () => {
    unwrap(
      await run(function* () {
        yield* storage()

        const files = service('files', {
          get: action.query(
            {
              input: z.object({ id: z.string() }),
              output: z.string(),
              errors: media.statuses,
            },
            function* ({ input }) {
              return input.id === 'ok' ? 'here' : yield* media.notFound(`no file ${input.id}`)
            },
          ),
        })

        const server = yield* createServer({ services: [files], edge: BunEdge })
        const info = yield* server.start({ port: 0 })

        const outcome = yield* attempt(() => server.call(files, 'get', { id: 'nope' }))
        expect((outcome as AnyType).error).toBe(media.notFound.tag)
        expect((outcome as AnyType).message).toBe('no file nope')

        const missing = yield* until(fetch(`${info.url}/files/get?id=nope`))
        expect(missing.status).toBe(404)
        expect(((yield* until(missing.json())) as AnyType).error.error).toBe('media.not-found')

        const found = yield* until(fetch(`${info.url}/files/get?id=ok`))
        expect(found.status).toBe(200)

        yield* server.stop()
      }),
    )
  })
})
