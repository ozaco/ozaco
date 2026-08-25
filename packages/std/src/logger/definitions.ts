import { all } from 'std:effect'
import { defineProtocol } from 'std:plugin'

import pkg from '../../package.json'

import { LOGGER, LOGGER_TRANSPORT } from './const'
import type { LoggerDef } from './types/logger'
import type { LoggerTransportDef } from './types/transport'

export const Logger = defineProtocol<LoggerDef.Context, LoggerDef.Actions>({
  name: 'logger',
  version: pkg.version,
  subtype: LOGGER,
})

export const LoggerTransport = defineProtocol<
  LoggerTransportDef.Context,
  LoggerTransportDef.Actions
>({
  name: 'logger-transport',
  version: pkg.version,
  subtype: LOGGER_TRANSPORT,
  cloneable: true,

  // Every LoggerTransport action (write/flush/close) fans out to ALL installed transports — the
  // transports are tracked simply by being installed, so there is no separate registry. Runs them
  // concurrently, mirroring the previous manual `all(transports.map(...))` dispatch.
  *exec(entries, run) {
    return yield* all(entries.map(entry => run(entry)))
  },
})
