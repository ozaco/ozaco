import { Carrier, Edge, Outcomes } from '../definition/protocol'
import type { CarrierDef } from '../types/carrier'
import type { EdgeDef } from '../types/edge'
import type { OutcomesDef } from '../types/outcomes'

/** Typed fallbacks for the contract members an impl never writes itself. */
export const edgeDefaults = (): EdgeDef.Defaults => ({
  *describe() {
    return yield* Edge.context.expect()
  },
})

export const carrierDefaults = (): CarrierDef.Defaults => ({
  *describe() {
    return yield* Carrier.context.expect()
  },
})

export const outcomesDefaults = (): OutcomesDef.Defaults => ({
  *describe() {
    return yield* Outcomes.context.expect()
  },
})
