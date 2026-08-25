import type { Flow } from 'std:effect'
import { createSignal, fork, operation, resource, until } from 'std:effect'

import { watch as fsWatch, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import type { Client, Expression, SubscriptionConfig, WatchProjectResponse } from 'fb-watchman'

import type { WatchEvent, WatchOptions } from '../types/common'

const SUBSCRIPTION = 'ozaco-config'

/** Promisify a callback-style watchman client command. */
const call = <T>(run: (callback: (error: Error | null, response: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    run((error, response) => {
      if (error) {
        reject(error)
        return
      }
      resolve(response)
    })
  })

/** Load the optional `fb-watchman` client constructor, or `null` when it is not installed. */
const loadClient = async (): Promise<(new () => Client) | null> => {
  try {
    const mod = await import('fb-watchman')
    const fromDefault = (mod as { default?: { Client?: new () => Client } }).default?.Client
    return mod.Client ?? fromDefault ?? null
  } catch {
    return null
  }
}

/** A file matches by exact name; a directory matches every file beneath it (Watchman is recursive). */
const subscriptionConfig = (
  watched: WatchProjectResponse,
  name: string | undefined,
): SubscriptionConfig => {
  const expression: Expression = name ? ['name', name] : ['type', 'f']
  const config: SubscriptionConfig = { expression, fields: ['name', 'exists'] }
  if (watched.relative_path) {
    config.relative_root = watched.relative_path
  }
  return config
}

/**
 * Establish a Watchman subscription for `path`, forwarding changes to `emit`. Returns a teardown
 * function, or `null` when Watchman is unusable (the optional `fb-watchman` package is missing, the
 * daemon is unreachable, or `STD_WATCHMAN=off`) so the caller falls back to `fs.watch`.
 */
const startWatchman = async (
  path: string,
  emit: (event: WatchEvent) => void,
): Promise<(() => void) | null> => {
  if (process.env.STD_WATCHMAN === 'off') {
    return null
  }

  const ClientCtor = await loadClient()
  if (!ClientCtor) {
    return null
  }

  const client = new ClientCtor()
  client.on('error', () => {})

  try {
    // capabilityCheck also verifies the daemon is reachable.
    await call(callback =>
      client.capabilityCheck({ optional: [], required: ['wildmatch'] }, callback),
    )

    const info = await stat(path)
    const isDir = info.isDirectory()
    const root = isDir ? path : dirname(path)
    const name = isDir ? undefined : basename(path)

    const watched = await call<WatchProjectResponse>(callback =>
      client.command(['watch-project', root], callback),
    )
    await call(callback =>
      client.command(
        ['subscribe', watched.watch, SUBSCRIPTION, subscriptionConfig(watched, name)],
        callback,
      ),
    )

    client.on('subscription', response => {
      // Skip the initial full listing Watchman sends on subscribe (`is_fresh_instance`).
      if (
        response.subscription !== SUBSCRIPTION ||
        (response as { is_fresh_instance?: boolean }).is_fresh_instance
      ) {
        return
      }
      for (const file of response.files) {
        emit({ type: file.exists ? 'change' : 'rename', path: file.name })
      }
    })

    return () => {
      client.command(['unsubscribe', watched.watch, SUBSCRIPTION], () => {})
      client.end()
    }
  } catch {
    client.end()
    return null
  }
}

/** The `fs.watch` fallback: drain the async iterator into `emit` until `signal` aborts. */
const drainNative = (
  spec: { path: string; recursive: boolean; signal: AbortSignal },
  emit: (event: WatchEvent) => void,
) =>
  operation(function* () {
    const iterator = fsWatch(spec.path, {
      recursive: spec.recursive,
      signal: spec.signal,
    })[Symbol.asyncIterator]()

    try {
      for (;;) {
        const result = yield* until(iterator.next())
        if (result.done) {
          break
        }
        const { eventType, filename } = result.value
        emit({ type: eventType === 'rename' ? 'rename' : 'change', path: filename })
      }
    } catch {
      // aborted on teardown, or the watch errored — stop quietly
    }
  })

/**
 * Watch a file or directory, streaming {@link WatchEvent}s until the consumer tears the stream down.
 * Prefers Watchman (optional `fb-watchman`); falls back to `fsPromises.watch`. `provide` suspends this
 * resource, so the fallback iterator is drained from a background task; teardown ends the Watchman
 * client or aborts the iterator (releasing the OS watcher).
 */
export const watchPath = (path: string, options?: WatchOptions): Flow<WatchEvent, never> =>
  resource(function* (provide) {
    const events = createSignal<WatchEvent, never>()
    const emit = (event: WatchEvent) => events.send(event)

    const stopWatchman = yield* until(startWatchman(path, emit))
    const controller = stopWatchman ? undefined : new AbortController()

    if (controller) {
      yield* fork(
        drainNative(
          { path, recursive: options?.recursive ?? false, signal: controller.signal },
          emit,
        ),
      )
    }

    try {
      yield* provide(yield* events)
    } finally {
      stopWatchman?.()
      controller?.abort()
    }
  })
