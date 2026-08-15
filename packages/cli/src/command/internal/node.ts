import { definePlugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import { COMMAND } from '../const'
import type { CommandDef } from '../types/command'
import type { RuntimeNode } from '../types/internal'

/**
 * Compile a spec into a plugin whose identity is its full tree path (e.g. `kube.local.setup`).
 *
 * A command's plugin identity is its `name@version` tag, and the effect scope + hook-store key off
 * that STRING. So two commands that merely share a human name (a `config` under `kube` and one under
 * `app`) would otherwise map to the same slot and clobber each other. A path is unique by
 * construction and — unlike a counter — deterministic and readable in errors/traces.
 *
 * `setup` runs the command's OWN setup only; children are installed lazily by the dispatcher as it
 * descends, so registering a root never sets up its whole subtree.
 */
const compile = (spec: CommandDef.Spec, path: string): CommandDef.Built =>
  definePlugin({
    subtype: COMMAND,
    name: path,
    description: spec.description,
    version: spec.version ?? '0.0.0',
    setup: function* (...args: AnyType[]) {
      return spec.setup ? yield* (spec.setup as AnyType)(...args) : undefined
    } as AnyType,
  }).build(spec.leaf as AnyType) as CommandDef.Built

/**
 * Eagerly build the whole command subtree (pure — no `setup` runs here; that happens at install).
 * Each node's plugin is identified by its path from the registered root, so identity is positional.
 */
export const buildNode = (spec: CommandDef.Spec, path: string): RuntimeNode => {
  const children: Record<string, RuntimeNode> = {}
  for (const [key, child] of Object.entries(spec.subs)) {
    children[key] = buildNode(child, `${path}.${key}`)
  }

  return {
    name: spec.name,
    description: spec.description,
    plugin: compile(spec, path),
    children,
  }
}
