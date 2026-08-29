import { CliErrors, Terminal } from 'cli:core'
import type { StandardSchemaV1 } from 'cli:core'
import { usePalette } from 'cli:palette'
import type { Operation } from 'std:effect'
import { scoped } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { validateSync } from 'std:shared'

import { HELP_FLAGS, VERSION_FLAGS } from '../const'
import type { CommandDef } from '../types/command'
import type { Helpers } from '../types/helpers'

import { processArgv } from './argv'
import { build } from './build'
import { renderActionHelp, renderCommandHelp } from './help'
import { optionsFromAction } from './schema'
import { tokenize } from './tokenize'

const hasFlag = (argv: string[], flags: string[]): boolean =>
  argv.some(token => flags.includes(token))

const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string =>
  issues
    .map(issue => {
      const path = (issue.path ?? [])
        .map(seg =>
          typeof seg === 'object' ? String((seg as { key: PropertyKey }).key) : String(seg),
        )
        .join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('\n')

function* descend(node: Helpers.RuntimeNode, rest: string[], path: string[]): Operation<void> {
  const token = rest[0]

  if (token !== undefined && !token.startsWith('-') && node.children[token] !== undefined) {
    const next = node.children[token]!
    return yield* scoped(function* () {
      // Install ONLY the child on the invoked path — never its siblings. Each subcommand gets its
      // own child scope (which inherits the parent's contexts via the scope prototype chain), so
      // sibling commands stay isolated: their `setup`s don't run and their contexts never leak in.
      // This is also what lets subcommands be compiled as independent bundles (each carrying its
      // own copy of @ozaco/*) — co-installing two separate bundles into one scope would otherwise
      // collide.
      yield* install(next.plugin as AnyType)
      return yield* descend(next, rest.slice(1), [...path, token])
    })
  }

  return yield* dispatch(node, rest, path)
}

function* dispatch(node: Helpers.RuntimeNode, rest: string[], path: string[]): Operation<void> {
  const palette = yield* usePalette()
  const command = node.plugin

  const keys = command.getKeys()
  const head = rest[0]
  let actionKey: string | undefined
  let actionArgv = rest
  let actionPath = path
  if (head !== undefined && !head.startsWith('-') && keys.includes(head)) {
    actionKey = head
    actionArgv = rest.slice(1)
    actionPath = [...path, head]
  } else if (keys.includes('default')) {
    actionKey = 'default'
  }

  if (command.version !== undefined && hasFlag(rest, VERSION_FLAGS)) {
    yield* Terminal.actions.write(`${command.version}\n`)
    return
  }

  if (actionKey === undefined) {
    yield* Terminal.actions.write(`${renderCommandHelp(node, path, palette)}\n`)
    return
  }

  const meta = (command.getMeta(actionKey) ?? {}) as CommandDef.ActionMeta
  const infos = yield* optionsFromAction(meta)
  const short = meta.short ?? {}
  const argsOrder = meta.args ?? []
  const actionHelp: Helpers.ActionHelp = {
    path: actionPath,
    description: meta.description,
    infos,
    short,
    args: argsOrder,
  }

  if (hasFlag(actionArgv, HELP_FLAGS)) {
    yield* Terminal.actions.write(`${renderActionHelp(actionHelp, palette)}\n`)
    return
  }

  const raw = yield* tokenize(actionArgv, infos, short)
  const built = build(infos, raw, argsOrder)
  const errors = [...raw.errors]
  let ctx: unknown = built

  if (meta.input !== undefined && errors.length === 0) {
    const result = validateSync(meta.input, built)
    if (isFailure(result)) {
      errors.push(formatIssues(result.error))
    } else {
      ctx = result.value
    }
  }

  if (errors.length > 0) {
    const text = errors.join('\n')
    const help = renderActionHelp(actionHelp, palette)
    yield* Terminal.actions.write(`${palette.colors.error(text)}\n\n${help}\n`)
    return yield* fail(CliErrors.Parse, text)
  }

  yield* command.actions[actionKey]!(ctx)
}

/**
 * Parse argv against a command tree and dispatch the matched action (the CLI analog of
 * `Broker.call`).
 *
 * Walks `subcommands` LAZILY: the root is installed in its own scope here, then to descend into a
 * child it opens a fresh child scope and installs ONLY that child — its `setup` runs then, the CLI
 * analog of "entering" a command — so only the commands on the invoked path are ever set up,
 * siblings stay isolated, and each level's context is visible to the levels below (child scopes
 * inherit their parent). When no child token matches, the current node's leaf action is resolved,
 * its argv built + validated, and dispatched.
 *
 * Requires Terminal + Palette installed. The root node is built + stored by `register` but its
 * `setup` is NOT run there — it runs here, lazily, so registering many top-level commands never
 * collides.
 */
export function* runCommand(root: Helpers.RuntimeNode, argv?: string[]): Operation<void> {
  const args = (argv ?? processArgv()).slice()
  // Install the root command in its OWN scope (running its setup) here, not at register — the
  // top-level analog of how `descend` enters a child. Only the invoked command's setup ever runs,
  // so sibling top-level commands (e.g. two plugins that each install YamlCodec) never collide.
  return yield* scoped(function* () {
    yield* install(root.plugin as AnyType)
    return yield* descend(root, args, [root.name])
  })
}
