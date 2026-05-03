import type { ActionRequest, ActionResponse } from '../types/action'

export const createEmptyReq = (): ActionRequest => ({
  type: 'internal',
  from: 'internal',
  method: 'INTERNAL',
  url: new URL('internal:///'),
  meta: {},
  files: {},
  rawBody: null,
})

export const createEmptyRes = (): ActionResponse => ({
  status: null,
  meta: {},
  files: {},
  body: null,
})
