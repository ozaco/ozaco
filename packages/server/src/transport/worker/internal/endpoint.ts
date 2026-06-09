import type { Operation } from 'std:effect'
import { createQueue, operation, until, withHost } from 'std:effect'
import { fail } from 'std:result'

import type { WorkerDef } from '../types'

import { streamOf } from './stream'

const globalWorkerCtor = () =>
  (
    globalThis as unknown as {
      Worker: new (script: string | URL, options?: { type?: 'module' }) => WorkerDef.PortLike
    }
  ).Worker

const wrapPort = (
  port: WorkerDef.PortLike,
  wire: WorkerDef.WireMode,
  initiallyReady: boolean,
): WorkerDef.Endpoint => {
  const queue = createQueue<unknown, void>()

  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', event => queue.add(event.data))
    port.start?.()
  } else if (typeof port.on === 'function') {
    port.on('message', data => queue.add(data))
  }

  let ready = initiallyReady
  const outbox: WorkerDef.Envelope[] = []

  return {
    wire,
    post: message => {
      if (!ready) {
        outbox.push(message)
        return
      }
      try {
        port.postMessage(message)
      } catch {
        /* peer already torn down */
      }
    },
    recv: streamOf(queue),
    markReady: () => {
      if (ready) {
        return
      }
      ready = true
      for (const message of outbox.splice(0)) {
        port.postMessage(message)
      }
    },
    close: () => {
      try {
        port.terminate?.()
        port.close?.()
      } catch {
        /* already gone */
      }
    },
  }
}

const spawnWorker = (script: string | URL): Operation<WorkerDef.PortLike, unknown> =>
  withHost<WorkerDef.PortLike, unknown>({
    *browser() {
      return new (globalWorkerCtor())(script, { type: 'module' })
    },
    *bun() {
      return new (globalWorkerCtor())(script, { type: 'module' })
    },
    *deno() {
      return new (globalWorkerCtor())(script, { type: 'module' })
    },
    *node() {
      const mod = yield* until(import('node:worker_threads'))
      return new mod.Worker(script) as unknown as WorkerDef.PortLike
    },
  })

const parentEndpoint = withHost<WorkerDef.PortLike, unknown>({
  *browser() {
    return globalThis as unknown as WorkerDef.PortLike
  },
  *bun() {
    return globalThis as unknown as WorkerDef.PortLike
  },
  *deno() {
    return globalThis as unknown as WorkerDef.PortLike
  },
  *node() {
    const mod = yield* until(import('node:worker_threads'))
    if (!mod.parentPort) {
      return yield* fail('worker', 'not running inside a node worker (parentPort is null)')
    }
    return mod.parentPort as unknown as WorkerDef.PortLike
  },
})

export const createEndpoints = operation(function* (options: WorkerDef.Options) {
  const wire = options.wire ?? 'structured'

  if (options.endpoint !== undefined) {
    const ports = Array.isArray(options.endpoint) ? options.endpoint : [options.endpoint]
    return ports.map(port => wrapPort(port, wire, true))
  }

  if (options.script !== undefined) {
    const endpoints: WorkerDef.Endpoint[] = []
    for (let i = 0; i < (options.count ?? 1); i++) {
      endpoints.push(wrapPort(yield* spawnWorker(options.script), wire, false))
    }
    return endpoints
  }

  return [wrapPort(yield* parentEndpoint, wire, true)]
})
