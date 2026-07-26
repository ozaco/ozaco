import { isObject } from 'std:shared'

import { CoreStatusMap, DEFAULT_STATUS } from '../const'
import type { Outcome } from '../types/common'

/** A handler that never got to decide. Distinct from one that decided to fail. */
const HALT_STATUS: Record<Outcome.Halt, number> = {
  timeout: 504,
  shutdown: 503,
  cancelled: 499,
}

const byTag = (
  tag: string,
  overrides: Array<Record<string, number> | null | undefined>,
): number => {
  for (const map of overrides) {
    if (map && tag in map) {
      return map[tag]!
    }
  }

  return CoreStatusMap[tag as keyof typeof CoreStatusMap] ?? DEFAULT_STATUS
}

/**
 * What status this failure should become.
 *
 * Precedence, top wins:
 *
 * 1. what the handler had ALREADY SET before it failed — a 422 written with `useResponse()` on the
 *    way out is the action's own answer, and throwing it away in favour of a tag lookup is how a
 *    deliberate 4xx came back as a 500;
 * 2. `halted` — the handler never decided, so no tag of its can speak for it;
 * 3. the per-route and app-wide overrides, in the order given;
 * 4. the core table;
 * 5. 500.
 *
 * A bare string is still accepted, because not every failure reaching a surface came off the call
 * path — only calls are guaranteed to carry a {@link Outcome.Fault}.
 */
export const statusFor = (
  code: unknown,
  ...overrides: Array<Record<string, number> | null | undefined>
): number => {
  if (isObject(code) && typeof code['tag'] === 'string') {
    const fault = code as unknown as Outcome.Fault

    if (fault.response?.status !== undefined) {
      return fault.response.status
    }
    if (fault.halted !== undefined) {
      return HALT_STATUS[fault.halted]
    }

    return byTag(fault.tag, overrides)
  }

  if (typeof code !== 'string') {
    return DEFAULT_STATUS
  }

  return byTag(code, overrides)
}
