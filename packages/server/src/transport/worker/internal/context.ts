import type { TransportDef } from 'server:core'
import { useContext } from 'std:effect'

import { WorkerTransport } from '../definition'
import type { WorkerDef } from '../types'

export const getSelf = (): TransportDef => WorkerTransport

export const useWorkerContext = function* () {
  const ctx = yield* useContext(getSelf())
  return ctx as unknown as WorkerDef.Context
}
