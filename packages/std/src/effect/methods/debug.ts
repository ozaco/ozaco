import { DebugContext } from '../internal/contexts'
import type { Operation } from '../types/operation'

let globalDebugFn: ((desc: string) => void) | undefined

export function enableGlobalDebug(enabled: boolean | ((desc: string) => void) = true): void {
  if (typeof enabled === 'function') {
    globalDebugFn = enabled
  } else if (enabled) {
    globalDebugFn = desc => console.log('[effect]', desc)
  } else {
    globalDebugFn = undefined
  }
}

export function getGlobalDebug(): ((desc: string) => void) | undefined {
  return globalDebugFn
}

export function* debug(
  enabled: boolean | ((desc: string) => void) | 'force-silence' = true,
): Operation<void> {
  if (enabled === 'force-silence') {
    yield* DebugContext.set('force-silence')
  } else if (typeof enabled === 'function') {
    yield* DebugContext.set(enabled)
  } else if (enabled) {
    yield* DebugContext.set(desc => console.log('[effect]', desc))
  } else {
    yield* DebugContext.delete()
  }
}
