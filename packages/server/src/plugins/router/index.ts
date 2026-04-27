import type { Helpers } from 'server:core'

import {
  addAction,
  DefaultRouterImpl,
  findAction,
  hasAction,
  mountAction,
  optimizeAction,
  removeAction,
  unmountAction,
} from './actions/router'

export const DefaultRouter: Helpers.DefaultRouter = DefaultRouterImpl.build({
  add: addAction,
  has: hasAction,
  remove: removeAction,
  find: findAction,

  optimize: optimizeAction,
  unmount: unmountAction,

  mount: mountAction,
})
