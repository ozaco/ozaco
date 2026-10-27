import { action, service } from 'server:core'
import type { AuthDef } from 'server:plugins'
import { Audit, Auth, StaticAuth } from 'server:plugins'
import { TestNode } from 'server:testing'
import { run } from 'std:effect'
import { fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

// `Audit.use(...)`: one domain record per write — who, what, outcome — in front of the exporters.

const things = service('things', {
  list: action.query({ output: z.array(z.string()) }, function* () {
    return ['a']
  }),
  create: action.mutation(
    { input: z.object({ title: z.string() }), output: z.object({ id: z.string() }) },
    function* ({ input }) {
      if (input.title === 'boom') {
        return yield* fail('things.boom', 'refused')
      }

      return { id: `t-${input.title}` }
    },
  ),
  rename: action.mutation(
    { input: z.object({ id: z.string(), title: z.string() }), output: z.boolean() },
    function* () {
      return true
    },
  ),
})

/** The records of one stream the recorder holds, as their flattened attributes. */
const streamOf = (node: AnyType, stream: string): Record<string, unknown>[] =>
  node.recorder
    .logs((log: AnyType) => log.attributes['ozaco.local.stream'] === stream)
    .map((log: AnyType) => log.attributes)

const field = (attributes: Record<string, unknown>, name: string): unknown =>
  Object.entries(attributes).find(([key]) => key === name || key.endsWith(`.${name}`))?.[1]

describe('audit plugin', () => {
  it('records writes with the actor, the target and the outcome; reads and skipped calls are left alone', async () => {
    unwrap(
      await run(function* () {
        const node = yield* TestNode.use({
          services: [things],
          record: true,
          plugins: [
            StaticAuth.use({ tokens: { 'tok-ada': { sub: 'u-ada', roles: ['admin'] } } }),
            Auth.use(),
            Audit.use({
              skip: call => call.action === 'rename',
              fields: (_call, ctx) => ({
                tenant: (ctx.auth as AuthDef.Principal | null)?.roles[0] ?? 'none',
              }),
            }),
          ],
        })
        const asAda = { meta: { authorization: 'Bearer tok-ada' } }

        yield* node.call(things, 'list')
        yield* node.call(things, 'create', { title: 'one' }, asAda)
        yield* node.call(things, 'rename', { id: 't-one', title: 'uno' }, asAda)
        yield* node.stop()

        const records = streamOf(node, 'audit')

        expect(records).toHaveLength(1)
        expect(field(records[0]!, 'service')).toBe('things')
        expect(field(records[0]!, 'action')).toBe('create')
        expect(field(records[0]!, 'actor')).toBe('u-ada')
        expect(field(records[0]!, 'actor_type')).toBe('user')
        expect(field(records[0]!, 'outcome')).toBe('ok')
        expect(field(records[0]!, 'tenant')).toBe('admin')
      }),
    )
  })

  it('a failed write ships too, with its tag; an anonymous caller is named so', async () => {
    unwrap(
      await run(function* () {
        const node = yield* TestNode.use({
          services: [things],
          record: true,
          plugins: [Audit.use({ stream: 'trail' })],
        })

        const outcome = yield* node.json('/things/create', { body: { title: 'boom' } })

        expect(outcome.status).toBe(500)
        yield* node.stop()

        const trail = streamOf(node, 'trail')

        expect(trail).toHaveLength(1)
        expect(field(trail[0]!, 'outcome')).toBe('failed')
        expect(field(trail[0]!, 'error')).toBe('things.boom')
        expect(field(trail[0]!, 'actor_type')).toBe('anonymous')
        // a `null` field is not an attribute (telemetry drops it)
        expect(field(trail[0]!, 'target')).toBeUndefined()
      }),
    )
  })
})
