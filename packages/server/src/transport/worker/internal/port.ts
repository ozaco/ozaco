// oxlint-disable import/exports-last
// oxlint-disable unicorn/require-post-message-target-origin -- worker ports take no targetOrigin
import { CoreErrors } from 'server:core'
import { until } from 'std:effect'
import type { Operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { WorkerWire } from '../types'

/** What the carrier wires into a port: sequential message delivery plus a death notification. */
export interface PortHandlers {
  readonly message: (data: unknown) => void
  readonly death: () => void
}

/** The worker global surface the child role attaches to under bun (Web Worker API). */
interface BunWorkerGlobal {
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  postMessage(message: unknown): void
}

const isBunRuntime = (): boolean => typeof Bun !== 'undefined'

/**
 * HOST role: spawn one worker running `script` and reduce it to a {@link WorkerWire.Port}. Bun uses the
 * Web Worker API (`new Worker(url)` — TS entries load natively); node uses `node:worker_threads`.
 * `death` fires on exit/close AND on uncaught worker errors (an errored worker is not trusted to
 * keep serving dispatches).
 */
export function* spawnWorker(
  script: string | URL,
  handlers: PortHandlers,
): Operation<WorkerWire.Port> {
  if (isBunRuntime()) {
    const worker = new Worker(script)

    worker.addEventListener('message', (event: AnyType) => handlers.message(event.data))
    worker.addEventListener('close', () => handlers.death())
    worker.addEventListener('error', () => handlers.death())

    return {
      post: message => worker.postMessage(message),
      terminate: () => void worker.terminate(),
    }
  }

  const threads = yield* until(import('node:worker_threads'))
  const worker = new threads.Worker(script)

  worker.on('message', (data: unknown) => handlers.message(data))
  worker.on('exit', () => handlers.death())
  worker.on('error', () => handlers.death())

  return {
    post: message => worker.postMessage(message),
    terminate: () => void worker.terminate(),
  }
}

/**
 * CHILD role: attach to the parent port (bun worker global `self`, node `parentPort`). Fails with
 * `Configuration` outside a worker — the child role only makes sense inside one.
 */
export function* attachParent(handlers: PortHandlers): Operation<WorkerWire.Port> {
  if (isBunRuntime()) {
    const workerGlobal = globalThis as unknown as Partial<BunWorkerGlobal>

    if (typeof workerGlobal.postMessage !== 'function') {
      return yield* fail(
        CoreErrors.Configuration,
        'the worker carrier child role must run inside a worker (no parent port found)',
      )
    }

    const live = workerGlobal as BunWorkerGlobal

    live.addEventListener('message', event => handlers.message(event.data))

    return {
      post: message => live.postMessage(message),
      terminate: () => {},
    }
  }

  const threads = yield* until(import('node:worker_threads'))
  const port = threads.parentPort

  if (!port) {
    return yield* fail(
      CoreErrors.Configuration,
      'the worker carrier child role must run inside a worker thread (no parentPort)',
    )
  }

  port.on('message', (data: unknown) => handlers.message(data))

  return {
    post: message => port.postMessage(message),
    terminate: () => {},
  }
}
