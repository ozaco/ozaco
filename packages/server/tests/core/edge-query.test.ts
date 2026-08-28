/**
 * Query strings read with the DECLARED schema's eyes: a field the input types as an array wraps
 * a single pass (`?v=a` → `['a']`), repeated keys stay arrays, scalars stay scalars — the
 * scalar/array duality of query params ends at the declaration.
 */
import { action, createServer, Edge, service } from 'server:core'
import { run, until } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { z } from 'zod'

import { storage } from '../helpers'

const q = service('q', {
  find: action.query(
    {
      input: z.object({
        tags: z.array(z.string()).optional(),
        limit: z.number().optional(),
        one: z.string().optional(),
      }),
      output: z.object({
        tags: z.array(z.string()).optional(),
        limit: z.number().optional(),
        one: z.string().optional(),
      }),
    },
    function* ({ input }) {
      return input
    },
  ),
})

const get = function* (path: string) {
  const response = yield* Edge.actions.handle(new Request(`http://edge${path}`))
  return { status: response.status, body: JSON.parse(yield* until(response.text())) }
}

describe('edge — query strings by the declared schema', () => {
  it('wraps single passes into declared array fields; scalars and repeats behave', async () => {
    unwrap(
      await run(function* () {
        yield* storage()
        const server = yield* createServer({ services: [q], edge: BunEdge })
        yield* server.start()

        // one pass into a DECLARED array field is that array's one element
        expect((yield* get('/q/find?tags=a')).body).toEqual({ tags: ['a'] })

        // repeated keys were already arrays
        expect((yield* get('/q/find?tags=a&tags=b')).body).toEqual({ tags: ['a', 'b'] })

        // scalars stay scalars — coercion is untouched
        expect((yield* get('/q/find?one=x&limit=5')).body).toEqual({ one: 'x', limit: 5 })

        // together
        expect((yield* get('/q/find?tags=only&one=x')).body).toEqual({
          tags: ['only'],
          one: 'x',
        })
        yield* server.stop()
      }),
    )
  })
})
