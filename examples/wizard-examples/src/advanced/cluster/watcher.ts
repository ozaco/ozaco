import { ensure, main, suspend } from 'std:effect'
import { Logger } from 'std:logger'

import { createClient } from '@ozaco/client'

import { startNode } from './shared'

type Note = { title: string; done: boolean }
type Delta =
  | { type: 'reset' }
  | { type: 'sync'; data: Note[] }
  | { type: 'added' | 'modified'; row: Note }
  | { type: 'removed'; id: string }
type Api = {
  notes: { list: { kind: 'query'; args: { limit?: number }; result: unknown; emits: Delta } }
}

/**
 * Cluster node "watcher" — watches `notes.list` over its OWN gateway and prints every delta. The rows
 * it prints are inserted by the WRITER node; they reach this process purely through NATS. The
 * auto-attached change bus forwards the writer's committed writes into this node's `changes` signal,
 * which re-runs the watched query against the shared database and emits the delta to the local client.
 */
await main(function* () {
  yield* startNode({
    nodeId: 'watcher',
    port: 4802,
    database: './cluster.db',
    nats: 'nats://localhost:4222',
  })
  yield* Logger.actions.info(
    'watcher up on :4802 — watching notes.list (writes come from the writer)…',
  )

  const client = createClient<Api>({ url: 'http://localhost:4802' })
  const stop = yield* client.notes.list.watch({}, delta => {
    if (delta.type === 'sync') {
      console.log('sync:', delta.data.map(note => note.title).join(', ') || '(empty)')
    } else if (delta.type === 'reset') {
      console.log('reset — server regressed, refetching')
    } else if (delta.type === 'removed') {
      console.log('removed:', delta.id)
    } else {
      console.log(`${delta.type} (from the writer node):`, delta.row.title)
    }
  })

  yield* ensure(function* () {
    yield* stop()
  })

  // Stay up and keep printing deltas until interrupted.
  yield* suspend()
})
