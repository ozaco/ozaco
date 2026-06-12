import type { ActionRequest, ActionResponse } from '../types/gateway'

/** A blank request envelope for internal/RPC dispatch that originates outside an HTTP/WS request. */
export const createEmptyReq = (): ActionRequest => ({
  type: 'internal',
  method: 'INTERNAL',
  url: new URL('internal:///'),
  meta: {},
  files: {},
})

export const createEmptyRes = (): ActionResponse => ({
  status: null,
  meta: {},
  files: {},
  body: null,
})
