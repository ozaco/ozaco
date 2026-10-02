import { Terminal } from 'cli:core'
import { createColors, createSymbols, Palette } from 'cli:palette'
import { ensure, useContext, useScope } from 'std:effect'
import type { TraceDef } from 'std:trace'
import { Trace } from 'std:trace'

import pkg from '../../package.json'

import { MAX_PENDING } from './internal/const'
import { strayLines } from './internal/lines'
import { flush, pendingOf, touch, widthOf } from './internal/pending'
import type { TerminalTracerDef } from './types/trace'

const TerminalTracerImpl = Trace.implement<
  TerminalTracerDef.Context,
  [options?: TerminalTracerDef.Options]
>({
  name: 'cli-terminal-tracer',
  version: pkg.version,
  description: 'std:trace → the terminal: every trace drawn as a timeline when it completes',

  /** Installed after the `Terminal` and (optionally) the `Palette`: it draws through the first and
   * paints with the second — no palette installed means plain ASCII, uncoloured. Turns tracing on
   * for its scope (an impl's setup does); the traces still collected when the scope closes are
   * drawn then. */
  *setup(options = {}) {
    yield* Trace.actions.enableTracing()

    const palette = (yield* Palette.context.get()) ?? {
      color: false,
      unicode: false,
      colors: createColors(false),
      symbols: createSymbols(false),
    }

    const context: TerminalTracerDef.Context = {
      width: options.width,
      idleMs: options.idleMs ?? 1000,
      palette,
      scope: yield* useScope(),
      pending: new Map(),
      options,
    }

    yield* ensure(function* () {
      for (const traceId of Array.from(context.pending.keys())) {
        yield* flush(context, traceId)
      }
    })

    return context
  },
})

/**
 * The terminal sink for std:trace (`cli:trace`) — `yield* TerminalTracer.use()` after the
 * `Terminal` impl and the `Palette`: every trace is drawn as ONE block, a Gantt-like timeline —
 * a header (trace id, service, root name, span count, total time, wall clock), then a row per
 * span in tree order with its bar on the shared time axis (the kind's palette colour; `error`
 * when the span failed, `warning` when a failure passed through it), its events (`◆`, an
 * `exception` `✖`) and records (`◇`) as markers on the bar, the records' lines under it, its
 * duration and outcome. Glyphs follow the palette's `unicode`, colours its `colors`, the width
 * the terminal's size at each draw (`width` pins it).
 *
 * A sink sees spans only as they END, so a block is drawn when the trace's root span (no parent)
 * ends — everything of the trace in this process is under it by then — else once the trace was
 * quiet for `idleMs` (a span answering a remote caller, an orphan, the children of a long
 * stream); whatever arrives after a block was drawn goes into a further block of the same trace,
 * so a long trace shows up live, piece by piece, and complete at its end. A record outside every
 * span prints as one line at once. Logger-bridged records (`severityText` set — what std's
 * `TraceTransport` sends) are skipped: the Logger's `ConsoleTransport` prints those lines already.
 */
export const TerminalTracer = TerminalTracerImpl.build({
  *export(span: TraceDef.SpanData) {
    const ctx = yield* useContext(TerminalTracerImpl.context)
    const pending = pendingOf(ctx, span.context.traceId)

    pending.spans.push(span)

    if (span.parent === null || pending.spans.length >= MAX_PENDING) {
      yield* flush(ctx, span.context.traceId)
    } else {
      touch(ctx, span.context.traceId)
    }
  },

  *emit(log: TraceDef.LogData) {
    const ctx = yield* useContext(TerminalTracerImpl.context)

    if (log.severityText !== undefined) {
      return
    }

    if (log.context === null) {
      yield* Terminal.actions.write(
        `${strayLines(log, { palette: ctx.palette, width: yield* widthOf(ctx) }).join('\n')}\n`,
      )

      return
    }

    pendingOf(ctx, log.context.traceId).logs.push(log)
    touch(ctx, log.context.traceId)
  },
})
