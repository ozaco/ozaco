import type { ActionRequest, ActionResponse } from '../types/action'

export const createEmptyReq = (body: unknown): ActionRequest => ({
  method: 'INTERNAL',
  url: new URL('internal:///'),
  meta: {},
  files: {},
  body,
  raw: null,
  rawBody: null,
})

export const createEmptyRes = (): ActionResponse => ({
  status: null,
  meta: {},
  files: {},
  body: null,
  raw: null,
})
