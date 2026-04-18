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
  parse = 'server:transformer#parse',
}

export const SERVER = Symbol.for('server:core:server')
export const ROUTER = Symbol.for('server:core:router')
export const REST_TRANSFORMER = Symbol.for('server:core:rest-transformer')
