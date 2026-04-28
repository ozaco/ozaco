import type { Future } from 'std:effect'

import type { Helpers } from './helpers'

export type LoggerTransportContext = unknown

export interface LoggerTransportActions {
  write(entry: Helpers.LogEntry): Future<void, unknown>
  flush(): Future<void, unknown>
  close(): Future<void, unknown>
}
