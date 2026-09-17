import { defineProtocol } from 'std:plugin'
import type { AnyType } from 'std:shared'

import pkg from '../../package.json'

import type { IODef } from './types/io'

/** The platform IO protocol. Its impls (`BunIO`, `NodeIO`, `WebIO`) keep no per-install state —
 * `setup` resolves `null`, so the context slot is unused. */
export const IO = defineProtocol<AnyType, IODef.Actions>({
  name: 'std/io',
  version: pkg.version,
  description: 'Platform IO: filesystem, flows, paths, processes, net, env, crypto, ids, watch, s3',
})
