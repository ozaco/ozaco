import { operation } from 'std:effect'

import { DenoGatewayAdapter, denoImpl } from 'server:gateway/deno'
import type { DenoLike } from 'server:gateway/deno'

import { runGatewaySuite } from './helpers'

/**
 * A DenoLike backed by Bun.serve — proves the adapter's HTTP path end to end without a Deno
 * runtime. WebSocket upgrades need the real `Deno.upgradeWebSocket`, so the ws leg of the suite
 * is skipped here (covered by bun/node; real-deno e2e is env-gated future work).
 */
const fakeDeno: DenoLike = {
  serve(options, handler) {
    const server = Bun.serve({
      port: options.port ?? 0,
      hostname: options.hostname ?? '127.0.0.1',
      fetch: request => handler(request),
    })

    return {
      addr: { port: server.port ?? 0, hostname: options.hostname ?? '127.0.0.1' },
      shutdown: () => {
        server.stop(true)

        return Promise.resolve()
      },
    }
  },
  upgradeWebSocket() {
    throw new Error('fake deno cannot upgrade websockets')
  },
}

runGatewaySuite({
  label: 'deno (fake runtime)',
  enabled: true,
  websocket: false,
  adapter: DenoGatewayAdapter,
  prepare: operation(function* () {
    yield* denoImpl.set(fakeDeno)
  }),
})
