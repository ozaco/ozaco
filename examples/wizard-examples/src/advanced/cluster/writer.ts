import { Broker, DataType } from 'server:core'
import { main, sleep } from 'std:effect'
import { Logger } from 'std:logger'

import { noteResource, startNode } from './shared'

/**
 * Cluster node "writer" — inserts a note every 1.5s and does nothing else. It never talks to the
 * watcher directly: each committed write is broadcast over NATS by the auto-attached change bus, and
 * the watcher node (a separate process) picks it up. Run the watcher in another terminal, with a NATS
 * server up — see this folder's README.
 */
await main(function* () {
  yield* startNode({
    nodeId: 'writer',
    port: 4801,
    database: './cluster.db',
    nats: 'nats://localhost:4222',
  })
  yield* Logger.actions.info('writer up on :4801 — inserting a note every 1.5s…')

  for (let i = 1; ; i++) {
    const note = yield* Broker.actions.call(noteResource, 'create', [
      { type: DataType.normal, value: { title: `note-${i}` } },
    ])
    yield* Logger.actions.info('inserted', { id: note._id, title: note.title })
    yield* sleep(1500)
  }
})
