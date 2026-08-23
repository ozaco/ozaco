import type { ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { realtime } from './internal'
import type { ResourceDef } from './types'

/**
 * Resources: mount a `/<name>/_realtime` socket route per `crud()` service (delta watches with
 * `since` token resume, sanitized filters, the resource's `read` auth on the handshake).
 */
export const Resource = definePlugin<ServerDef.PluginContext, [options: ResourceDef.PluginOptions]>(
  {
    name: 'server-resource',
    version: '0.5.0',
    description: 'CRUD resources with realtime delta watches',

    *setup(options) {
      const kernel = yield* Server.context.get()
      if (!kernel) {
        return yield* fail(ServerErrors.Configuration, 'Resource must be installed by createServer')
      }
      const suffix = options.realtimePath ?? '/_realtime'
      return {
        hooks: {
          name: 'resource',
          *start() {
            const edge = kernel.edge
            if (!edge) {
              return
            }
            for (const resource of options.resources) {
              yield* edge.actions.socket({
                path: `/${resource.service.name}${suffix}`,
                handler: realtime(resource),
                service: resource.service.name,
                protocol: 'resource',
                description: 'watch/unwatch frames in, sync/delta/error frames out',
              })
            }
          },
        },
      }
    },
  },
).build()
