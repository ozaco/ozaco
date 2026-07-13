import type { GatewayDef } from 'server:core'
import { Gateway } from 'server:core'

import { isPausedAction, isStartedAction, pauseAction, resumeAction } from '../shared/lifecycle'
import { listenAction } from '../shared/listen'
import {
  broadcastAction,
  emitAction,
  joinAction,
  leaveAction,
  onCloseAction,
  onMessageAction,
  onOpenAction,
  toRoomAction,
} from '../shared/realtime'
import { fromInternalAction, restSettingsAction, toInternalAction } from '../shared/rest'
import {
  addAction,
  findAction,
  hasAction,
  mountAction,
  optimizeAction,
  removeAction,
  unmountAction,
} from '../shared/router'
import { setup } from '../shared/setup'
import { wsSettingsAction } from '../shared/ws'

import { destroyAction, startAction } from './internal'
import { upgradeAction } from './ws'

export const BunGateway: GatewayDef.Default = Gateway.implement({
  name: 'server/gateway-bun',
  version: '0.0.0',

  setup,
}).build({
  start: startAction,
  isStarted: isStartedAction,
  pause: pauseAction,
  isPaused: isPausedAction,
  resume: resumeAction,
  destroy: destroyAction,

  add: addAction,
  remove: removeAction,
  has: hasAction,
  find: findAction,
  optimize: optimizeAction,
  mount: mountAction,
  unmount: unmountAction,

  toInternal: toInternalAction,
  fromInternal: fromInternalAction,
  rest: restSettingsAction,

  upgrade: upgradeAction,
  onOpen: onOpenAction,
  onMessage: onMessageAction,
  onClose: onCloseAction,
  ws: wsSettingsAction,

  emit: emitAction,
  broadcast: broadcastAction,
  join: joinAction,
  leave: leaveAction,
  toRoom: toRoomAction,
  listen: listenAction,
})

export { wsBearer } from '../shared/ws'
