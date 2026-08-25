import { useContext } from 'std:effect'
import { definePlugin } from 'std:plugin'

import pkg from '../../package.json'

import { buildContext } from './internal/context'
import { makeInstance, openInstance } from './internal/instance'
import type { ConfigDef } from './types'

const ConfigImpl = definePlugin<ConfigDef.Context, [options?: ConfigDef.Options]>({
  name: 'std/config',
  version: pkg.version,
  description: 'Hierarchical config discovery, merge, and edit',

  *setup(options) {
    return yield* buildContext(options)
  },
})

/** The default instance runs against the scope-installed context. */
const defaultInstance = makeInstance(() => useContext(ConfigImpl.context))

/**
 * The config plugin: discovers `<name>.<ext>` files from `cwd` up to `home`, resolves each file's
 * `extends`, and merges them (plus the active variant, the config-dir files, and an env overlay) into
 * one view. Requires an `IO` impl and a codec installed first. Precedence per level: variant → dir →
 * base; inner levels win over outer; the env overlay wins over all. `Config.actions.*` operate on the
 * installed (singleton) config; `Config.actions.open(options)` mints extra, independent instances.
 */
export const Config = ConfigImpl.build<ConfigDef.Actions>({
  ...defaultInstance,
  open: openInstance,
})
