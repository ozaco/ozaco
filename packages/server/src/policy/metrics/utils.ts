import type { PolicyDef } from 'server:core'

import { MetricsPolicy } from './definition'

export const getSelf = (): PolicyDef => MetricsPolicy

// metrics hooks are purely observational: a throwing hook must never alter the dispatch result
export const runHook = (hook: (() => void) | undefined) => {
  if (!hook) {
    return
  }
  try {
    hook()
  } catch {
    // swallow — observability must not turn a successful call into a failed one
  }
}
