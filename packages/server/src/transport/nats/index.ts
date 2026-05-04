import { callAction } from './actions/call'
import { destroyAction } from './actions/destroy'
import { NatsTransportImpl } from './actions/impl'
import { isPausedAction } from './actions/is-paused'
import { isStartedAction } from './actions/is-started'
import { mountAction } from './actions/mount'
import { pauseAction } from './actions/pause'
import { resumeAction } from './actions/resume'
import { settingsAction } from './actions/settings'
import { startAction } from './actions/start'
import { unmountAction } from './actions/unmount'

export const NatsTransport = NatsTransportImpl.build({
  call: callAction,
  mount: mountAction,
  unmount: unmountAction,
  settings: settingsAction,
  start: startAction,
  pause: pauseAction,
  resume: resumeAction,
  destroy: destroyAction,
  isStarted: isStartedAction,
  isPaused: isPausedAction,
})

export * from './error-codes'
