import type { Helpers } from 'server:core'

import {
  fromInternalAction,
  RestImpl,
  settingsAction as restSettingsAction,
  toContextAction,
  toInternalAction,
} from './actions/rest'
import {
  BunImpl,
  destroyAction,
  isPausedAction,
  isStartedAction,
  pauseAction,
  resumeAction,
  startAction,
} from './actions/server'
import {
  onCloseAction,
  onMessageAction,
  onOpenAction,
  upgradeAction,
  WsImpl,
  settingsAction as wsSettingsAction,
} from './actions/ws'

export const BunServer = BunImpl.build({
  start: startAction,
  isStarted: isStartedAction,
  pause: pauseAction,
  isPaused: isPausedAction,
  resume: resumeAction,
  destroy: destroyAction,
})

export const BunRest: Helpers.DefaultRestTransformer = RestImpl.build({
  toInternal: toInternalAction,
  toContext: toContextAction,
  fromInternal: fromInternalAction,
  settings: restSettingsAction,
})

export const BunWs: Helpers.DefaultWsTransformer = WsImpl.build({
  upgrade: upgradeAction,
  onOpen: onOpenAction,
  onMessage: onMessageAction,
  onClose: onCloseAction,
  settings: wsSettingsAction,
})
