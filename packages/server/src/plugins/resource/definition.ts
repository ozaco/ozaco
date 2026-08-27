import type { ServerDef } from 'server:core'
import { definePlugin } from 'std:plugin'

import pkg from '../../../package.json'

import type { ResourceDef } from './types'

/**
 * @deprecated `crud()` now carries its own `_realtime` socket (an `action.socket` entry of the
 * service, `realtimePath` crud option moves it) — nothing is left to mount, so installing
 * Resource is a NO-OP kept only so existing `Resource.use({ resources })` calls keep booting.
 * Drop it from `plugins`.
 */
export const Resource = definePlugin<ServerDef.PluginContext, [options: ResourceDef.PluginOptions]>(
  {
    name: 'server-resource',
    version: pkg.version,
    description: 'deprecated no-op — crud services mount their own realtime socket',

    *setup() {
      return { hooks: { name: 'resource' } }
    },
  },
).build()
