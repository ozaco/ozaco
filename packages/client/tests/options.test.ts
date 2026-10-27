import type { ManifestDef } from 'client:core'
import { ClientErrors, createClient } from 'client:core'
import { attempt, run } from 'std:effect'
import { fail, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

// `prefix` mounts every route under a path; `messages` + `$text` turn a failure into the line a
// screen shows.

const manifest: ManifestDef.Manifest = {
  manifest: 'ozaco/2',
  name: 'options-test',
  version: '0.0.0',
  instance: 'i1',
  errors: {},
  services: [
    {
      name: 'demo',
      version: '0.0.0',
      actions: [
        {
          id: 'demo.echo',
          service: 'demo',
          action: 'echo',
          kind: 'query',
          route: { method: 'GET', path: '/demo/echo' },
          input: {
            plane: 'value',
            brand: null,
            contentType: null,
            schema: { type: 'object', properties: { text: { type: 'string' } } },
          },
          output: {
            plane: 'value',
            brand: null,
            contentType: 'application/json',
            schema: { type: 'object', properties: { text: { type: 'string' } } },
          },
          errors: {},
          tags: [],
          options: {},
        },
      ],
    },
  ],
}

/** A fetch that remembers every URL it was asked for and answers the manifest or an echo. */
const recording = () => {
  const seen: string[] = []
  const fetchImpl = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)

    seen.push(url)

    const body = url.includes('/docs/manifest') ? manifest : { text: 'hi' }

    return Promise.resolve(Response.json(body))
  }) as unknown as typeof fetch

  return { seen, fetchImpl }
}

describe('client — prefix', () => {
  it('prepends the mount path to the manifest and every route', async () => {
    const { seen, fetchImpl } = recording()

    const echoed = unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          prefix: '/api/',
          fetch: fetchImpl,
        })

        return yield* client.$call('demo.echo', { text: 'hi' })
      }),
    )

    expect(echoed).toEqual({ text: 'hi' })
    expect(seen[0]).toBe('http://host.test/api/docs/manifest')
    expect(seen[1]).toBe('http://host.test/api/demo/echo?text=hi')
  })

  it('without a prefix the routes sit at the root', async () => {
    const { seen, fetchImpl } = recording()

    unwrap(
      await run(function* () {
        const client = yield* createClient({ url: 'http://host.test', manifest, fetch: fetchImpl })

        return yield* client.$call('demo.echo', { text: 'hi' })
      }),
    )

    expect(seen).toEqual(['http://host.test/demo/echo?text=hi'])
  })
})

describe('client — messages and $text', () => {
  it('a cause the messages name wins over the tag, the tag over the fallback, the fallback over the message', async () => {
    const texts = unwrap(
      await run(function* () {
        const client = yield* createClient({
          url: 'http://host.test',
          manifest,
          messages: {
            'users:last-admin': 'The last admin stays.',
            'server.conflict': 'Someone else changed it.',
            [ClientErrors.Network]: 'Offline.',
          },
        })

        const lastAdmin = yield* attempt(() =>
          fail('server.conflict', 'conflict on users', 'users:last-admin', 'req:r1'),
        )
        const conflict = yield* attempt(() => fail('server.conflict', 'conflict on rows', 'req:r2'))
        const unknown = yield* attempt(() => fail('demo.teapot', 'short and stout'))
        const network = yield* attempt(() => fail(ClientErrors.Network, 'ConnectionRefused'))

        return {
          lastAdmin: client.$text(lastAdmin),
          conflict: client.$text(conflict),
          unknownWithFallback: client.$text(unknown, 'Something went wrong.'),
          unknownBare: client.$text(unknown),
          network: client.$text(network),
          notAFailure: client.$text(new Error('plain')),
        }
      }),
    )

    expect(texts).toEqual({
      lastAdmin: 'The last admin stays.',
      conflict: 'Someone else changed it.',
      unknownWithFallback: 'Something went wrong.',
      unknownBare: 'short and stout',
      network: 'Offline.',
      notAFailure: 'plain',
    })
  })
})
