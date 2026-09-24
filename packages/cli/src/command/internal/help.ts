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

const showDefault = (value: unknown): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value) && value.length === 0) {
    return '[]'
  }
  return Array.isArray(value) ? value.map(showDefault).join(', ') : String(value)
}

/** The right column of an option/argument line: description, then the muted metadata. */
const detailsFor = (
  info: CommandDef.OptionInfo | undefined,
  palette: PaletteDef.Context,
): string => {
  if (info === undefined) {
    return ''
  }
  const notes: string[] = []
  if (info.enum !== undefined) {
    notes.push(`choices: ${info.enum.join('|')}`)
  }
  if (info.hasDefault) {
    notes.push(`default: ${showDefault(info.default)}`)
  } else if (info.required) {
    notes.push('required')
  }
  const meta = notes.length === 0 ? '' : palette.colors.muted(`(${notes.join(', ')})`)
  return [info.description ?? '', meta].filter(part => part !== '').join(' ')
}

/** `<name>` for a required positional, `[name]` for an optional one, `...` for a variadic tail. */
const argLabel = (
  name: string,
  info: CommandDef.OptionInfo | undefined,
  variadic: boolean,
): string => {
  const label = variadic ? `${name}...` : name
  return info !== undefined && info.required && !info.hasDefault ? `<${label}>` : `[${label}]`
}

const examplesSection = (
  examples: readonly CommandDef.Example[],
  palette: PaletteDef.Context,
): string[] =>
  examples.length === 0
    ? []
    : [
        '',
        palette.colors.bold('Examples:'),
        ...section(
          examples.map(example => [
            example.run,
            example.note === undefined ? '' : palette.colors.muted(example.note),
          ]),
          palette.colors.accent,
        ),
      ]

/**
 * Usage, arguments, options and examples for a single action (subcommand). Positional `args`
 * fields render as `<name>` under `Arguments:` (not as flags); descriptions, defaults and required
 * marks come from the resolved option metadata (the input schema's JSON Schema or the manual
 * declarations).
 */
export const renderActionHelp = (
  action: Helpers.ActionHelp,
  palette: PaletteDef.Context,
): string => {
  const { colors } = palette
  const out: string[] = []
  const byName = new Map(action.infos.map(info => [info.name, info]))
  const positional = new Set(action.args)
  const flags = action.infos.filter(info => !positional.has(info.name))

  if (action.description !== undefined) {
    out.push(action.description, '')
  }

  const labels = action.args.map((arg, index) => {
    const info = byName.get(arg)
    return argLabel(arg, info, info?.array === true && index === action.args.length - 1)
  })
  const usage = [...action.path]
  if (flags.length > 0) {
    usage.push('[options]')
  }
  usage.push(...labels)
  out.push(`${colors.bold('Usage:')} ${usage.join(' ')}`)

  if (action.args.length > 0) {
    out.push(
      '',
      colors.bold('Arguments:'),
      ...section(
        action.args.map((arg, index) => [labels[index]!, detailsFor(byName.get(arg), palette)]),
        colors.accent,
      ),
    )
  }

  if (flags.length > 0) {
    out.push(
      '',
      colors.bold('Options:'),
      ...section(
        flags.map(info => [flagsFor(info, action.short), detailsFor(info, palette)]),
        colors.accent,
      ),
    )
  }

  out.push(...examplesSection(action.examples, palette))

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

  out.push(...examplesSection(node.examples ?? [], palette))

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
