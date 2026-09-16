import { Server, ServerErrors } from 'server:core'
import type { Task } from 'std:effect'
import { fork } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import pkg from '../../../package.json'

import { createState, reloadOnce, statusOf, watchRoots } from './internal'
import type { HotReloadDef } from './types'

/**
 * Hot reload for development: watch the service modules and swap the declarations into the
 * running node on every save — the port stays open, sockets stay connected, the database and
 * the carrier keep their sessions, only the routes and handlers change (`server.reload`). A
 * broken save is reported and the last good declarations keep serving. Dev only: production
 * nodes ship declarations, they do not watch them.
 */
const HotReloadPlugin = definePlugin<HotReloadDef.Context, [options: HotReloadDef.Options]>({
  name: 'server-hot-reload',
  version: pkg.version,
  description: 'Swap service declarations into the running node on file changes',

  *setup(options) {
    const kernel = yield* Server.context.get()

    if (!kernel) {
      return yield* fail(ServerErrors.Configuration, 'HotReload must be installed by createServer')
    }

    const state = yield* createState(options)
    const reload = () => reloadOnce(state, services => Server.actions.reload(services))
    let watcher: Task<void> | null = null

    return {
      reload,
      status: () => statusOf(state),
      hooks: {
        name: 'hot-reload',

        *start() {
          watcher = yield* fork(() => watchRoots(state, reload))
        },

        *stop() {
          state.watching = false

          if (watcher) {
            yield* watcher.halt()
            watcher = null
          }
        },
      },
    }
  },
})

export const HotReload = HotReloadPlugin.build({
  *reload() {
    return yield* (yield* HotReloadPlugin.context.expect()).reload()
  },

  *status() {
    return (yield* HotReloadPlugin.context.expect()).status()
  },
} satisfies HotReloadDef.Actions)
