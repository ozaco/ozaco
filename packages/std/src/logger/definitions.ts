import { defineProtocol } from 'std:plugin'

import { LOGGER, LOGGER_TRANSPORT } from './const'
import type { Helpers } from './types/helpers'
import type { LoggerActions, LoggerContext } from './types/logger'
import type { LoggerTransportActions, LoggerTransportContext } from './types/transport'

export const Logger = defineProtocol<
  LoggerContext,
  unknown,
  [options?: Helpers.LoggerOptions],
  LoggerActions
>({
  name: 'logger',
  version: '0.0.1',
  subtype: LOGGER,
})

export const LoggerTransport = defineProtocol<
  LoggerTransportContext,
  unknown,
  unknown[],
  LoggerTransportActions
>({
  name: 'logger-transport',
  version: '0.0.1',
  subtype: LOGGER_TRANSPORT,
  cloneable: true,
})
