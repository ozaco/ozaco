export const SERVER = Symbol.for('server:core:server')
export const ROUTER = Symbol.for('server:core:router')
export const REST_TRANSFORMER = Symbol.for('server:core:rest-transformer')
export const WS_TRANSFORMER = Symbol.for('server:core:ws-transformer')

export const JSON_CONTENT = 'application/json'
export const RAW_BINARY = 'application/octet-stream'
export const FORM_DATA = 'multipart/form-data'
export const FORM_URLENCODED = 'application/x-www-form-urlencoded'
export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

export const DEFAULT_REST_METHODS = {
  find: {
    method: 'GET',
    path: '/',
  },
  get: {
    method: 'GET',
    path: '/:id',
  },
  create: {
    method: 'POST',
    path: '/',
  },
  update: {
    method: 'PUT',
    path: '/:id',
  },
  patch: {
    method: 'PATCH',
    path: '/:id',
  },
  remove: {
    method: 'DELETE',
    path: '/:id',
  },
}
