import { isPlugin } from 'std:plugin'

import { LOGGER_TRANSPORT } from '../const'
import type { Helpers } from '../types/helpers'

export const isTransport = <T>(value: unknown): value is Helpers.AnyTransportPlugin<T> =>
  isPlugin(value) && (value as Helpers.AnyTransportPlugin)._st === LOGGER_TRANSPORT
