import { defineProtocol } from 'std:plugin'

import { LOGGER, LOGGER_TRANSPORT } from './const'
import { getTransportsHandler, registerHandler, unregisterHandler } from './internal/handlers'
import type { LoggerDef } from './types/logger'
import type { LoggerTransportDef } from './types/transport'

export const Logger = defineProtocol<
  LoggerDef.Context,
  unknown,
  [options?: LoggerDef.Options],
  LoggerDef.Actions,
  LoggerDef.Handlers
>({
  name: 'logger',
  version: '0.0.1',
  subtype: LOGGER,

  handlers: {
    register: registerHandler,
    unregister: unregisterHandler,
    getTransports: getTransportsHandler,
  },
})

export const LoggerTransport = defineProtocol<
  LoggerTransportDef.Context,
  unknown,
  unknown[],
  LoggerTransportDef.Actions
>({
  name: 'logger-transport',
  version: '0.0.1',
  subtype: LOGGER_TRANSPORT,
  cloneable: true,
})
