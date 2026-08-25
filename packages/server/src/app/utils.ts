import type { ServerDef, ServiceDef } from 'server:core'
import type { Operation } from 'std:effect'

import { App } from './definition'
import type { AppDef } from './types'

/** Build an app node: `createServer` under a role + `start/stop/info`. */
export function* createApp<const TServices extends readonly ServiceDef.Service[]>(
  options: AppDef.Options<TServices>,
): Operation<AppDef.Handle<TServices>> {
  const state = yield* App.use(options as AppDef.Options)

  return {
    server: state.server as ServerDef.Handle<TServices>,
    role: state.role,
    start: App.actions.start,
    stop: App.actions.stop,
    info: App.actions.info,
    health: App.actions.health,
  }
}
