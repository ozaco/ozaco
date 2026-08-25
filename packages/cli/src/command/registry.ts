import { defineProtocol } from 'std:plugin'

import pkg from '../../package.json'

import type { RegistryDef } from './types/registry'

/**
 * The command registry protocol (mirrors the backend `Broker`). Install `DefaultRegistry`,
 * `register` your commands (compiled, never set up eagerly), then `run(argv)` dispatches `argv[0]`
 * to the matching command tree.
 */
export const Registry = defineProtocol<RegistryDef.Context, RegistryDef.Actions>({
  name: 'cli-registry',
  version: pkg.version,
  description: 'Top-level command registry and argv dispatcher',
})
