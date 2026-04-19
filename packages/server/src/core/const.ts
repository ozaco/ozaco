export const SERVER = Symbol.for('server:core:server')
export const ROUTER = Symbol.for('server:core:router')
export const REST_TRANSFORMER = Symbol.for('server:core:rest-transformer')

export enum RouterTags {
  add = 'server:router#add',
  find = 'server:router#find',
  has = 'server:router#has',
  remove = 'server:router#remove',
  optimize = 'server:router#optimize',
  mount = 'server:router#mount',
  transformer = 'server:router#transformer',
}

export enum TransformerTags {
  toInternal = 'server:transformer#to-internal',
  toContext = 'server:transformer#to-context',
  fromInternal = 'server:transformer#from-internal',
  settings = 'server:transformer#settings',
}

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
