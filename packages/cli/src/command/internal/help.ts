import type { PaletteDef } from 'cli:palette'

import type { CommandDef } from '../types/command'
import type { Helpers } from '../types/helpers'
import type { RegistryDef } from '../types/registry'

// Pad the left column on its plain width, then paint it (keeps ANSI from breaking alignment).
const section = (entries: [string, string][], paint: (text: string) => string): string[] => {
  const width = entries.reduce((max, [left]) => Math.max(max, left.length), 0)
  return entries.map(([left, right]) => `  ${paint(left.padEnd(width))}  ${right}`.trimEnd())
}

const flagsFor = (info: CommandDef.OptionInfo, short: Record<string, string>): string => {
  const lead =
    short[info.name] === undefined ? `--${info.name}` : `-${short[info.name]}, --${info.name}`
  const hint =
    info.type === 'boolean'
      ? ''
      : info.array
        ? ' <value...>'
        : ` <${info.type === 'number' ? 'number' : 'value'}>`
  return `${lead}${hint}`
}

/** Usage + options for a single action (subcommand). */
export const renderActionHelp = (
  action: Helpers.ActionHelp,
  palette: PaletteDef.Context,
): string => {
  const { colors } = palette
  const out: string[] = []

  if (action.description !== undefined) {
    out.push(action.description, '')
  }

  const usage = [...action.path]
  if (action.infos.length > 0) {
    usage.push('[options]')
  }
  for (const arg of action.args) {
    usage.push(`<${arg}>`)
  }
  out.push(`${colors.bold('Usage:')} ${usage.join(' ')}`)

  if (action.infos.length > 0) {
    out.push(
      '',
      colors.bold('Options:'),
      ...section(
        action.infos.map(info => {
          const choices =
            info.enum === undefined ? '' : ` ${colors.muted(`(choices: ${info.enum.join('|')})`)}`
          return [flagsFor(info, action.short), choices]
        }),
        colors.accent,
      ),
    )
  }

  return out.join('\n')
}

/** Usage + the list of subcommands/actions for a group command. */
export const renderCommandHelp = (
  node: Helpers.RuntimeNode,
  path: string[],
  palette: PaletteDef.Context,
): string => {
  const { colors } = palette
  const command = node.plugin
  const out: string[] = []

  if (node.description !== undefined) {
    out.push(node.description, '')
  }
  out.push(`${colors.bold('Usage:')} ${path.join(' ')} <command> [options]`)

  const names = [
    ...Object.keys(node.children),
    ...command.getKeys().filter(key => key !== 'default'),
  ]

  if (names.length > 0) {
    out.push(
      '',
      colors.bold('Commands:'),
      ...section(
        names.map(name => {
          const child = node.children[name]
          const meta = child === undefined ? command.getMeta(name) : undefined
          const description = child?.description ?? (meta?.description as string | undefined) ?? ''
          return [name, description]
        }),
        colors.accent,
      ),
    )
  }

  return out.join('\n')
}

/** Top-level program help: lists every registered command. */
export const renderProgramHelp = (
  ctx: RegistryDef.Context,
  palette: PaletteDef.Context,
): string => {
  const { colors } = palette
  const out: string[] = []

  if (ctx.description !== undefined) {
    out.push(ctx.description, '')
  }
  out.push(`${colors.bold('Usage:')} ${ctx.name} <command> [options]`)

  const entries = [...ctx.commands.values()].map(
    command => [command.name, command.description ?? ''] as [string, string],
  )
  if (entries.length > 0) {
    out.push('', colors.bold('Commands:'), ...section(entries, colors.accent))
  }

  return out.join('\n')
}
