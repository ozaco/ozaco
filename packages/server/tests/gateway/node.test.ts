import { NodeGatewayAdapter } from 'server:gateway/node'

import { runGatewaySuite } from './helpers'

// node:http (and the `ws` peer) run fine under bun — this exercises the node adapter code path;
// a real-node subprocess run is part of the phase-8 topology e2e.
runGatewaySuite({
  label: 'node',
  enabled: true,
  websocket: true,
  adapter: NodeGatewayAdapter,
})
