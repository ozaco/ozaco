import type { LoggerTransportDef } from '../../types/transport'

import { FileTransport } from './definition'

export const encoder = new TextEncoder()
export const getTranport = (): LoggerTransportDef => FileTransport
