import { BunEdge } from 'server:impl/edge/bun'

import { runEdgeSuite } from '../suites/edge'

runEdgeSuite({ label: 'bun', enabled: true, edge: BunEdge, listens: true })
