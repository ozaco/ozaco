/**
 * `client.address` (HTTP semconv) of a direct client: with no proxy header, the PEER the runtime
 * saw — each driver hands it to the engine (Bun `requestIP`, node `socket.remoteAddress`, Deno
 * `remoteAddr`) — on the request span and on the websocket upgrade span; a forwarding header
 * still names the client behind the proxies.
 */
import type { ServerDef } from 'server:core'
import { action, createServer, Edge, service } from 'server:core'
import { run, sleep, until } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import type { TraceDef } from 'std:trace'

import { describe, expect, it } from 'bun:test'

import { BunEdge } from 'server:impl/edge/bun'
import { DenoEdge, denoImpl } from 'server:impl/edge/deno'
import { NodeEdge } from 'server:impl/edge/node'

import { storage } from '../helpers'

import { fakeDeno } from './fake-deno'

const probe = service('probe', {
  ping: action.query({}, function* () {
    return 'pong'
  }),
})

/** Every span the kernel reports. */
const spy = () => {
  const spans: TraceDef.SpanData[] = []
  const plugin = definePlugin<ServerDef.PluginContext, []>({
    name: 'spy',
    version: '0',
    description: 'captures spans',
    *setup() {
      const hooks: ServerDef.Hooks = {
        name: 'spy',
        *observe(event) {
          if (event.t === 'span') {
            spans.push(event.span)
          }
        },
      }

      return { hooks }
    },
  }).build()

  return { plugin, spans }
}

/** Open a socket, wait for its greeting, close it. */
const greet = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)

    ws.addEventListener('message', () => ws.close())
    ws.addEventListener('close', () => resolve())
    ws.addEventListener('error', () => reject(new Error('socket error')))
  })

const EDGES: readonly { label: string; edge: AnyType; use?: () => AnyType }[] = [
  { label: 'bun', edge: BunEdge },
  { label: 'node', edge: NodeEdge },
  {
    label: 'deno',
    edge: DenoEdge.use(),
    *use() {
      yield* denoImpl.set(fakeDeno as AnyType)
    },
  },
]

describe('edge drivers — client.address from the peer', () => {
  for (const { label, edge, use } of EDGES) {
    it(`${label}: a direct client is its peer address; a forwarding header still wins`, async () => {
      const seen = spy()

      unwrap(
        await run(function* () {
          yield* storage()

          if (use) {
            yield* use()
          }

          const server = yield* createServer({ services: [probe], edge, plugins: [seen.plugin] })

          yield* Edge.actions.socket({
            path: '/live',
            *handler(socket) {
              yield* socket.send({ t: 'hello' })
            },
          })

          const info = yield* server.start({ port: 0 })

          yield* until(fetch(`${info.url}/probe/ping?who=direct`).then(response => response.text()))
          yield* until(
            fetch(`${info.url}/probe/ping?who=proxied`, {
              headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
            }).then(response => response.text()),
          )
          yield* until(greet(`${info.url!.replace('http', 'ws')}/live`))
          yield* sleep(30)
          yield* server.stop()
        }),
      )

      const request = (who: string): TraceDef.SpanData =>
        seen.spans.find(
          span => span.kind === 'server' && span.attributes['url.query'] === `who=${who}`,
        )!

      expect(request('direct').attributes['client.address']).toBe('127.0.0.1')
      expect(request('proxied').attributes['client.address']).toBe('203.0.113.9')

      const upgrade = seen.spans.find(span => span.name === 'GET /live')!

      expect(upgrade.attributes['client.address']).toBe('127.0.0.1')
    })
  }
})
