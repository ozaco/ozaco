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
    services: new Set<string>(),
    post: message => {
      if (!ready) {
        outbox.push(message)
        return true
      }
      try {
        port.postMessage(message)
        return true
      } catch {
        return false
      }
    },
    recv: streamOf(queue),
    markReady: () => {
      if (ready) {
        return
      }
      ready = true
      for (const message of outbox.splice(0)) {
        try {
          port.postMessage(message)
          // oxlint-disable-next-line no-empty
        } catch {}
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

const spawnWorker = (script: string | URL): Operation<WorkerDef.PortLike> =>
  withHost<WorkerDef.PortLike>({
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

const parentEndpoint = withHost<WorkerDef.PortLike>({
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

const isSpecObject = (
  spec: WorkerDef.SpawnSpec,
): spec is { script: string | URL; count?: number } =>
  typeof spec === 'object' && spec !== null && !(spec instanceof URL) && 'script' in spec

const normalizeSpecs = (script: WorkerDef.Options['script']): WorkerDef.SpawnSpec[] =>
  script === undefined ? [] : Array.isArray(script) ? script : [script]

export const createEndpoints = operation(function* (options: WorkerDef.Options) {
  const wire = options.wire ?? 'structured'

  if (options.endpoint !== undefined) {
    const ports = Array.isArray(options.endpoint) ? options.endpoint : [options.endpoint]
    return ports.map(port => wrapPort(port, wire, true))
  }

  const specs = normalizeSpecs(options.script)
  if (specs.length > 0) {
    const endpoints: WorkerDef.Endpoint[] = []
    for (const spec of specs) {
      const script = isSpecObject(spec) ? spec.script : spec
      // bare entries inherit the top-level `count`; the object form overrides it per script.
      const count = isSpecObject(spec) ? (spec.count ?? options.count ?? 1) : (options.count ?? 1)
      for (let i = 0; i < count; i++) {
        endpoints.push(wrapPort(yield* spawnWorker(script), wire, false))
      }
    }
    return endpoints
  }

  return [wrapPort(yield* parentEndpoint, wire, true)]
})
