import type { Context } from 'std:effect'
import { createContext } from 'std:effect'

import { createClient } from 'redis'

import type { RedisKvDef } from './types'

/**
 * The client factory `RedisKv` dials through. Defaults to `createClient` from `redis`;
 * override it in the installing scope for fakes (`redisKvImpl.set({ createClient: fake })`).
 */
export const redisKvImpl: Context<RedisKvDef.ImplLike> = createContext<RedisKvDef.ImplLike>(
  'db:impl/redis-kv/client',
  { createClient: options => createClient(options) },
)
