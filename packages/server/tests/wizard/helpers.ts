// oxlint-disable import/exports-last
import { column, DbClient, table, useDb } from 'db:core'
import { DefaultGateway, Gateway, serverFrame, useRequest } from 'server:core'
import {
  crud,
  installWizard,
  mutation,
  query,
  resource,
  run as runFn,
  wizard,
  WizardErrors,
} from 'server:wizard'
import { operation, until } from 'std:effect'
import type { Operation } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { MemoryAdapter } from 'db:impl/memory'
import { SqliteAdapter } from 'db:impl/sqlite'
import { BunGatewayAdapter } from 'server:gateway/bun'
import { z } from 'zod'

import { bootstrap } from '../core/helpers'

/** The fixture table every wizard suite runs against. */
export const tasks = table('tasks', {
  title: column.text(),
  done: column.boolean().default(false),
  priority: column.int().default(0),
  owner: column.text().optional(),
})

/** Hook-style access guard: allows only requests carrying `x-role: admin`. */
export const adminOnly = operation(function* () {
  const request = yield* useRequest()

  return request.meta['x-role'] === 'admin'
})

const complete = mutation({
  args: z.object({ id: z.string() }),
  errors: { [WizardErrors.NotFound]: 404 },
  *handler(args) {
    const db = yield* useDb(tasks)
    const doc = yield* db.patch('tasks', args.id, { done: true })

    if (doc === null) {
      return yield* fail(WizardErrors.NotFound, `"tasks/${args.id}" not found`)
    }

    return doc
  },
})

const stats = query({
  watch: true,
  *handler() {
    const db = yield* useDb(tasks)
    const total = yield* db.query('tasks').count()
    const done = yield* db.query('tasks').where({ done: true }).count()

    return { total, done }
  },
})

/** Mutable fixture state for the reset tests — set `calls` to 0 before (re)watching `flaky`. */
export const flakyState = { calls: 0 }

/** Watchable query that succeeds on its first run and fails on every later one (reset fixture). */
const flaky = query({
  watch: true,
  *handler() {
    flakyState.calls += 1

    if (flakyState.calls > 1) {
      return yield* fail('tests.flaky', 'flaky recompute failed')
    }

    const db = yield* useDb(tasks)

    return { total: yield* db.query('tasks').count() }
  },
})

export const tasksResource = resource(tasks, {
  ...crud(tasks, { filters: ['done'], pageSize: 5, maxPageSize: 10 }),
  complete,
  flaky,
  stats,
})

export const lockedResource = resource(tasks, crud(tasks, { access: adminOnly }), {
  name: 'locked',
})

export const opsResource = resource('ops', {
  proxyComplete: mutation({
    args: z.object({ id: z.string() }),
    *handler(args) {
      return yield* runFn(tasksResource.complete, { id: args.id })
    },
  }),
  secret: query({
    access: adminOnly,
    *handler() {
      return { ok: true }
    },
  }),
})

export const api = wizard({ tasks: tasksResource, locked: lockedResource, ops: opsResource })

export type Api = typeof api

export interface WizardTarget {
  readonly label: string
  readonly install: () => Operation<unknown>
}

/** The db bindings the crud/realtime suites are parametrized over. */
export const targets: readonly WizardTarget[] = [
  { label: 'memory', install: () => install(MemoryAdapter) },
  { label: 'sqlite', install: () => install(SqliteAdapter) },
]

/** Broker + db + gateway + wizard, started on a random port. */
export const bootWizard = operation(function* (target: WizardTarget) {
  yield* bootstrap()
  yield* target.install()
  yield* install(DbClient, { tables: [tasks] })
  yield* install(BunGatewayAdapter)
  yield* install(DefaultGateway, { name: 'gw' })
  yield* installWizard(api)

  return yield* Gateway.actions.start({ port: 0 })
})

export interface HttpResult {
  readonly status: number
  readonly headers: Headers
  readonly body: AnyType
}

/** One JSON round trip against the started gateway. */
export const httpJson = operation(function* (input: {
  readonly url: string
  readonly method?: string | undefined
  readonly body?: unknown
  readonly headers?: Record<string, string> | undefined
}) {
  const response = yield* until(
    fetch(input.url, {
      method: input.method ?? 'GET',
      headers: {
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...input.headers,
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
  )
  const text = yield* until(response.text())
  const result: HttpResult = {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : (JSON.parse(text) as AnyType),
  }

  return result
})

export interface WsProbe {
  readonly send: (frame: unknown) => void
  readonly sendRaw: (text: string) => void
  readonly next: (timeoutMs?: number) => Promise<AnyType>
  /** true when NO frame arrives within the window. */
  readonly idle: (windowMs: number) => Promise<boolean>
  readonly close: () => void
}

/** Open a realtime probe: JSON frames in/out with promise-based delivery. */
export const openProbe = async (
  url: string,
  headers?: Record<string, string>,
): Promise<WsProbe> => {
  const socket = new WebSocket(url, { headers } as AnyType)
  const queue: AnyType[] = []
  const waiters: ((frame: AnyType) => void)[] = []

  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)) as AnyType
    const waiter = waiters.shift()

    if (waiter) {
      waiter(frame)
    } else {
      queue.push(frame)
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve()
    })
    socket.addEventListener('error', () => {
      reject(new Error('ws connect failed'))
    })
  })

  const next = (timeoutMs = 3000): Promise<AnyType> => {
    const queued = queue.shift()

    if (queued !== undefined) {
      return Promise.resolve(queued)
    }

    return new Promise((resolve, reject) => {
      const waiter = (frame: AnyType) => {
        clearTimeout(timer)
        resolve(frame)
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter)

        if (at !== -1) {
          waiters.splice(at, 1)
        }

        reject(new Error('ws frame timeout'))
      }, timeoutMs)

      waiters.push(waiter)
    })
  }

  const idle = (windowMs: number): Promise<boolean> => {
    if (queue.length > 0) {
      return Promise.resolve(false)
    }

    return new Promise(resolve => {
      let done = false
      const settle = (value: boolean) => {
        if (!done) {
          done = true
          resolve(value)
        }
      }
      const waiter = () => {
        clearTimeout(timer)
        settle(false)
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter)

        if (at !== -1) {
          waiters.splice(at, 1)
        }

        settle(true)
      }, windowMs)

      waiters.push(waiter)
    })
  }

  return {
    send: frame => socket.send(JSON.stringify(frame)),
    sendRaw: text => socket.send(text),
    next,
    idle,
    close: () => {
      socket.close()
    },
  }
}

export interface SseProbe {
  readonly status: number
  readonly headers: Headers
  /** Decoded JSON body for NON-stream (error) responses; `undefined` while streaming. */
  readonly body: AnyType
  /** Next decoded `data:` frame. */
  readonly next: (timeoutMs?: number) => Promise<AnyType>
  /** true when NO frame arrives within the window. */
  readonly idle: (windowMs: number) => Promise<boolean>
  /** true when the SERVER ends the stream within the window. */
  readonly closed: (timeoutMs?: number) => Promise<boolean>
  /** Client-side disconnect (aborts the fetch). */
  readonly abort: () => void
}

/**
 * Open a realtime SSE probe: fetch the streaming endpoint, parse `data:` lines into frames with
 * promise-based delivery. Error (non-`text/event-stream`) responses resolve with `body` set and
 * no frames.
 */
export const openSse = async (url: string, headers?: Record<string, string>): Promise<SseProbe> => {
  const controller = new AbortController()
  const response = await fetch(url, { headers, signal: controller.signal })
  const streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  const body = streaming || response.body === null ? undefined : await response.json()

  const queue: AnyType[] = []
  const waiters: ((frame: AnyType) => void)[] = []
  const doneWaiters: (() => void)[] = []
  let finished = !streaming

  const deliver = (frame: AnyType) => {
    const waiter = waiters.shift()

    if (waiter) {
      waiter(frame)
    } else {
      queue.push(frame)
    }
  }

  const finish = () => {
    finished = true

    for (const waiter of doneWaiters.splice(0)) {
      waiter()
    }
  }

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const chunk = await reader.read()

        if (chunk.done) {
          break
        }

        buffer += decoder.decode(chunk.value, { stream: true })

        let at = buffer.indexOf('\n\n')

        while (at !== -1) {
          const block = buffer.slice(0, at)

          buffer = buffer.slice(at + 2)

          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              deliver(JSON.parse(line.slice(6)))
            }
          }

          at = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // client-side abort
    }

    finish()
  }

  if (streaming && response.body) {
    void pump(response.body)
  }

  const next = (timeoutMs = 3000): Promise<AnyType> => {
    const queued = queue.shift()

    if (queued !== undefined) {
      return Promise.resolve(queued)
    }

    return new Promise((resolve, reject) => {
      const waiter = (frame: AnyType) => {
        clearTimeout(timer)
        resolve(frame)
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter)

        if (at !== -1) {
          waiters.splice(at, 1)
        }

        reject(new Error('sse frame timeout'))
      }, timeoutMs)

      waiters.push(waiter)
    })
  }

  const idle = (windowMs: number): Promise<boolean> => {
    if (queue.length > 0) {
      return Promise.resolve(false)
    }

    return new Promise(resolve => {
      let settled = false
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const waiter = () => {
        clearTimeout(timer)
        settle(false)
      }
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter)

        if (at !== -1) {
          waiters.splice(at, 1)
        }

        settle(true)
      }, windowMs)

      waiters.push(waiter)
    })
  }

  const closed = (timeoutMs = 3000): Promise<boolean> => {
    if (finished) {
      return Promise.resolve(true)
    }

    return new Promise(resolve => {
      let settled = false
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        settle(false)
      }, timeoutMs)

      doneWaiters.push(() => {
        clearTimeout(timer)
        settle(true)
      })
    })
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    next,
    idle,
    closed,
    abort: () => {
      controller.abort()
    },
  }
}

/** Zod-validates a received frame against the `serverFrame` wire schema, then returns it. */
export const checkFrame = (frame: unknown): AnyType => {
  const checked = serverFrame.safeParse(frame)

  if (!checked.success) {
    throw new Error(`invalid server frame: ${JSON.stringify(frame)}`)
  }

  return checked.data as AnyType
}
