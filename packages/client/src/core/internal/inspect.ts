import type { ClientDef } from '../types/client'
import type { Helpers } from '../types/helpers'

/** The handle behind any handle (typed or not) or `connectClient`'s promise of one. */
export const handleOf = (client: Helpers.HandleLike): Promise<ClientDef.Statics> =>
  Promise.resolve(client)
