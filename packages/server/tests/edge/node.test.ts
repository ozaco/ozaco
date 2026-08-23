import { NodeEdge } from 'server:impl/edge/node'

import { runEdgeSuite } from '../suites/edge'

runEdgeSuite({ label: 'node', enabled: true, edge: NodeEdge, listens: true })
