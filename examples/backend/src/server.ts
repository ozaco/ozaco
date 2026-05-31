import {
  Broker,
  DefaultBroker,
  defineAction,
  defineService,
  Gateway,
  useRequest,
} from 'server:core'
import type { Operation } from 'std:effect'
import { Logger } from 'std:logger'
import { install } from 'std:plugin'

import { BunGateway } from 'server:gateway/bun'
import { Cors } from 'server:plugin/cors'
import { Docs } from 'server:plugin/docs'
import z from 'zod'

/**
 * Layered HTTP + WebSocket gateway over the broker, with CORS + OpenAPI docs. Run `SERVICE=server`.
 * `Gateway` is one protocol — `BunGateway` owns its server, router, rest and ws internally. Actions
 * opt into routes via `Gateway.actions.rest({...})` / `Gateway.actions.ws({...})`; the gateway
 * dispatches each request through `Broker.actions.call`, so the policy chain + tracing apply. Then:
 *
 *   curl localhost:3000/web/hello/Mona                   # → { "message": "Hello, Mona!" }
 *   curl -X POST localhost:3000/web/echo -d '{"x":1}' -H 'content-type: application/json'
 *   curl localhost:3000/docs/openapi                     # OpenAPI 3 spec
 *   open  localhost:3000/docs/swagger                    # Swagger UI
 *
 * The route-bound socket at ws://localhost:3000/web/chat sends each frame to the `chat` action.
 * Swap BunGateway for NodeGateway (server:gateway/node) for HTTP on Node (no ws).
 */
const webService = defineService({
  name: 'web',
  version: '0.0.0',

  actions: {
    hello: defineAction(
      {
        settings: [Gateway.actions.rest({ method: 'GET', path: '/hello/:name' })],
        input: z.object({
          name: z.string().min(2),
        }),
      },
      function* (body) {
        return { message: `Hello, ${body.name ?? 'world'}!` }
      },
    ),

    echo: defineAction(
      { settings: [Gateway.actions.rest({ method: 'POST', path: '/echo' })] },
      function* (body) {
        const req = yield* useRequest()
        return { method: req.method, body }
      },
    ),

    chat: defineAction({ settings: [Gateway.actions.ws({ path: '/chat' })] }, function* (body) {
      return { echoed: body }
    }),
  },

  *setup() {},
})

export const runServerDemo = function* (port = 3000): Operation<void, unknown> {
  yield* install(DefaultBroker)
  yield* install(BunGateway, { port })
  yield* install(webService)
  yield* install(Cors, { origin: '*' })
  yield* install(Docs, { title: 'Ozaco Example API', version: '0.0.0' })

  yield* Broker.actions.register(webService)
  yield* Gateway.actions.mount('/web', webService)
  yield* Docs.actions.from(webService)
  yield* Broker.actions.start()
  yield* Gateway.actions.start({ port })

  yield* Logger.actions.info(`Gateway listening on http://localhost:${port}`)
}
