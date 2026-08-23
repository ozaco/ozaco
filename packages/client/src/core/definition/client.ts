import { definePlugin } from 'std:plugin'
import { fail } from 'std:result'

import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'

/**
 * The client plugin: holds the options and the (lazily fetched) manifest. `createClient` installs
 * it (with `Ws` + `JsonCodec` for the realtime route) and returns the typed handle.
 */
export const Client = definePlugin<ClientDef.Context, [options: ClientDef.Options]>({
  name: 'client',
  version: '0.5.0',
  description: 'Typed client of an @ozaco/server over its manifest',

  *setup(options) {
    if (!options?.url) {
      return yield* fail(ClientErrors.Configuration, 'createClient needs a url')
    }
    return { options, manifest: options.manifest ?? null, lastRequestId: null }
  },
}).build()
