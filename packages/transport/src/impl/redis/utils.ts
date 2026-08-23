import type { Context } from 'std:effect'
import { createContext } from 'std:effect'

import { createClient } from 'redis'

import type { Redis } from './types'

/** The client factory `RedisTransport` dials through. Defaults to `createClient` from `redis`;
 * override it in the installing scope for fakes (`redisImpl.set({ createClient: fake })`). */
export const redisImpl: Context<Redis.ImplLike> = createContext<Redis.ImplLike>(
  'transport:impl/redis/client',
  { createClient: options => createClient(options) },
)
