import { Transport } from '../definition'
import type { TransportDef } from '../types/transport'

/** Typed fallbacks for the contract members an impl never writes itself:
 * `Transport.implement({...}).build({ ...transportDefaults(), ...transportActions(driver) })`. */
export const transportDefaults = (): TransportDef.Defaults => ({
  *describe() {
    return yield* Transport.context.expect()
  },
})
