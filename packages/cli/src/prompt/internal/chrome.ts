import type { InlineParts } from '../types/internal'
import type { PromptDef, PromptContext } from '../types/prompt'

export const activeLine = (ctx: PromptContext, message: string): string => {
  const { colors, symbols } = ctx.palette
  return `${colors.bold(colors.primary(symbols.question))} ${colors.bold(message)}`
}

export const submittedLine = (ctx: PromptContext, message: string, value: string): string => {
  const { colors, symbols } = ctx.palette
  return `${colors.success(symbols.answered)} ${colors.bold(message)} ${colors.muted(symbols.separator)} ${colors.primary(value)}`
}

export const cancelledLine = (ctx: PromptContext, message: string): string => {
  const { colors, symbols } = ctx.palette
  return `${colors.error(symbols.error)} ${colors.bold(message)} ${colors.muted(symbols.separator)} ${colors.muted('cancelled')}`
}

export const inlineFrame = (ctx: PromptContext, message: string, parts: InlineParts): string => {
  const { colors, symbols } = ctx.palette
  const head = `${activeLine(ctx, message)} ${colors.primary(symbols.separator)} ${parts.body}`
  return parts.error === undefined ? head : `${head}\n${colors.error(parts.error)}`
}

export const hint = (ctx: PromptContext, text: string): string => ctx.palette.colors.muted(text)

export const label = <T>(choice: PromptDef.Choice<T>): string =>
  choice.label ?? String(choice.value)
