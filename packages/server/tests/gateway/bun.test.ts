import { BunGatewayAdapter } from 'server:gateway/bun'

import { runGatewaySuite } from './helpers'

runGatewaySuite({
  label: 'bun',
  enabled: true,
  websocket: true,
  adapter: BunGatewayAdapter,
})
