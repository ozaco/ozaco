import { Terminal } from 'cli:core'
import type { Operation } from 'std:effect'

import type { TerminalTracerDef } from '../types/trace'

import { renderBlock } from './block'
import { DEFAULT_WIDTH } from './const'

/** The trace's collection, started on first sight. */
export const pendingOf = (
  ctx: TerminalTracerDef.Context,
  traceId: string,
): TerminalTracerDef.Pending => {
  const found = ctx.pending.get(traceId)

  if (found) {
    return found
  }

  const made: TerminalTracerDef.Pending = { spans: [], logs: [], timer: undefined }

  ctx.pending.set(traceId, made)

  return made
}

/** The width a block is drawn at: the option, else the terminal's columns right now — a pipe
 * reports none (`fallback`), then {@link DEFAULT_WIDTH}. */
export const widthOf = function* (ctx: TerminalTracerDef.Context): Operation<number> {
  if (ctx.width !== undefined) {
    return ctx.width
  }

  const size = yield* Terminal.actions.size()

  return size.fallback || size.columns <= 0 ? DEFAULT_WIDTH : size.columns
}

/** Draw what the trace collected and forget it. */
export const flush = function* (ctx: TerminalTracerDef.Context, traceId: string): Operation<void> {
  const pending = ctx.pending.get(traceId)

  if (!pending) {
    return
  }

  ctx.pending.delete(traceId)

  if (pending.timer !== undefined) {
    clearTimeout(pending.timer)
  }

  const width = yield* widthOf(ctx)

  yield* Terminal.actions.write(
    `${renderBlock(pending, { width, palette: ctx.palette }).join('\n')}\n`,
  )
}

/** (Re)arm the trace's idle flush: it draws — as a task of the tracer's scope, a timer fires in
 * none — once nothing of the trace arrived for `idleMs`. */
export const touch = (ctx: TerminalTracerDef.Context, traceId: string): void => {
  const pending = pendingOf(ctx, traceId)

  if (pending.timer !== undefined) {
    clearTimeout(pending.timer)
  }

  pending.timer = setTimeout(() => {
    pending.timer = undefined
    ctx.scope.run(() => flush(ctx, traceId), { detached: true })
  }, ctx.idleMs)
}
