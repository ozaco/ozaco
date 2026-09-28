import type { ObserveDef, ServerDef } from 'server:core'
import { ServerErrors } from 'server:core'
import { createSink, resourceOf } from 'server:internal'
import type { Operation, Task } from 'std:effect'
import { all, attempt, fork, sleep } from 'std:effect'
import { fail, formatFailure, isFailure } from 'std:result'

import { DEFAULT_METRICS_INTERVAL_MS, DEFAULT_TIMEOUT_MS, USER_AGENT } from '../internal/const'
import { encodeMetrics } from '../internal/encode'
import { warnDelivery } from '../internal/log'
import { createMeter } from '../internal/metrics'
import { counters, retryOf, SIGNALS, upResources } from '../internal/pipeline'
import { deliver } from '../internal/transport'
import type { Helpers } from '../types/helpers'
import type { OtlpDef } from '../types/otlp'

import { encodeLogs, encodeSpans } from './encode'

/**
 * The whole OTLP/HTTP pipeline of one destination over a node's observe events — what
 * `OtlpExporter` and `OpenObserveExporter` are made of, and what an OTLP-speaking exporter of
 * one's own can reuse: per-signal batching sinks (a full batch leaves at once), the shared
 * encoder (`encoding`, default protobuf), the retrying / timing-out transport, the metrics
 * derived from the recorded spans (POSTed every `metrics.intervalMs` while the node runs, and
 * at `flush`), delivery counters and one WARN per failure streak. `handle` is the exporter's
 * `export` / `start` / `flush` — `flush` is the node's STOP (the kernel flushes its exporters
 * at stop only): the metrics beat ends with it (a stopped node reports no `ozaco.service.up`)
 * and the next `start` begins a new one. The url must already be validated.
 */
export function* createOtlpPipeline(
  kernel: ServerDef.Context,
  options: OtlpDef.Options,
): Operation<OtlpDef.Pipeline> {
  const encoding = options.encoding ?? 'protobuf'

  if (encoding !== 'protobuf' && encoding !== 'json') {
    return yield* fail(
      ServerErrors.Configuration,
      `OTLP encoding must be 'protobuf' or 'json', got '${String(encoding)}'`,
    )
  }

  const base = options.url.replace(/\/+$/u, '')
  const stats: OtlpDef.Stats = { spans: counters(), logs: counters(), metrics: counters() }
  const failing: Record<Helpers.SignalKey, boolean> = { spans: false, logs: false, metrics: false }
  const rejecting: Record<Helpers.SignalKey, boolean> = {
    spans: false,
    logs: false,
    metrics: false,
  }
  // the DESTINATION, not one signal: once a delivery failed for good without any HTTP answer
  // (refused, unresolvable, timed out) every signal's next delivery gets one attempt until the
  // destination answers again — a collector that is not there costs one retry budget, not three
  let reachable = true

  const targetOf = (signal: OtlpDef.Signal): Helpers.Target => ({
    signal,
    url: `${base}/v1/${signal}`,
    headers: { 'user-agent': USER_AGENT, ...options.headers, ...options.signalHeaders?.[signal] },
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    gzip: options.gzip === true,
    retry: retryOf(options.retry),
  })
  const targets: Readonly<Record<Helpers.SignalKey, Helpers.Target>> = {
    spans: targetOf(SIGNALS.spans),
    logs: targetOf(SIGNALS.logs),
    metrics: targetOf(SIGNALS.metrics),
  }

  // while the node stops: the moment the whole stop-time flush must end by (`timeoutMs` after it
  // began) — a batch still waiting then fails at once instead of taking its own `timeoutMs`
  let stopBy: number | null = null

  /** Deliver one encoded request of `key` within `timeoutMs` (and the stop's deadline); a final
   * failure is complained about once per streak and re-raised (the sink counts it), a
   * `partialSuccess` refusal is counted. */
  function* ship(key: Helpers.SignalKey, encoded: OtlpDef.Encoded): Operation<void> {
    const counts = stats[key]
    const target = targets[key]
    let answered = false
    const deadline = Math.min(Date.now() + target.timeoutMs, stopBy ?? Number.POSITIVE_INFINITY)
    // a destination whose last delivery failed for good gets ONE attempt until it answers again:
    // retries are for blips, and a known-down backend must not stall the beat or the stop
    const outcome = yield* attempt(() =>
      deliver(target, encoded, {
        stats: counts,
        deadline,
        attempts: failing[key] || !reachable ? 1 : target.retry.attempts,
        onAnswer: () => {
          answered = true
          reachable = true
        },
      }),
    )

    if (isFailure(outcome)) {
      counts.lastError = formatFailure(outcome)

      if (!answered) {
        reachable = false
      }

      if (!failing[key]) {
        failing[key] = true
        yield* warnDelivery(`otlp ${target.signal} delivery failing`, {
          'url.full': target.url,
          err: outcome,
        })
      }

      return yield* outcome
    }

    failing[key] = false

    const { rejected, message } = outcome.value

    if (rejected === 0 && message === null) {
      rejecting[key] = false

      return
    }

    counts.rejected += rejected
    counts.lastError = message ?? `${rejected} rejected`

    if (!rejecting[key]) {
      rejecting[key] = true
      yield* warnDelivery(`otlp ${target.signal}: the backend rejected ${rejected} record(s)`, {
        'url.full': target.url,
        'ozaco.otlp.rejected': rejected,
        'ozaco.otlp.message': message ?? '',
      })
    }
  }

  const encodeOptions: OtlpDef.EncodeOptions = { encoding }

  const spans = createSink<OtlpDef.SpanEvent>({
    ...options.batch,
    *send(events) {
      yield* ship('spans', encodeSpans(events, encodeOptions))
    },
  })
  const logs = createSink<OtlpDef.LogEvent>({
    ...options.batch,
    *send(events) {
      yield* ship('logs', encodeLogs(events, encodeOptions))
    },
  })

  // CUMULATIVE metrics since this exporter was made, POSTed on a fixed beat
  const withMetrics = options.metrics !== false
  const intervalMs =
    (options.metrics === false ? null : options.metrics?.intervalMs) ?? DEFAULT_METRICS_INTERVAL_MS
  const meter = createMeter(Date.now())
  let beat: Task<void> | null = null

  function* exportMetrics(): Operation<void> {
    const entries = meter.collect(Date.now(), upResources(kernel), {
      resource: resourceOf(kernel, null),
      requests: [...kernel.active.values()],
    })

    if (entries.length === 0) {
      return
    }

    const outcome = yield* attempt(() => ship('metrics', encodeMetrics(entries, encoding, {})))

    if (isFailure(outcome)) {
      stats.metrics.failed += 1
    } else {
      stats.metrics.sent += 1
    }
  }

  const handle: ObserveDef.ExporterActions = {
    *export(event) {
      if (event.t === 'span') {
        spans.push(event)
      } else {
        logs.push(event)
      }

      if (withMetrics) {
        meter.record(event)
      }
    },
    *start() {
      yield* spans.start()
      yield* logs.start()

      // ONE beat per running node: a restart after a stop begins a new one, never a second
      if (withMetrics && beat === null) {
        beat = yield* fork(function* () {
          for (;;) {
            yield* sleep(intervalMs)
            yield* exportMetrics()
          }
        })
      }
    },
    *flush() {
      // the node stops: no beat reports it after this (a halted beat's POST is aborted)
      const running = beat

      beat = null

      if (running) {
        yield* running.halt()
      }

      // the whole stop gets `timeoutMs`: every delivery it makes (or waits for) ends by then
      stopBy = Date.now() + targets.spans.timeoutMs

      try {
        // the signals leave side by side: a slow or retrying one never holds the others back
        yield* all([spans.flush(), logs.flush(), ...(withMetrics ? [exportMetrics()] : [])])
      } finally {
        stopBy = null
      }
    },
  }

  return {
    url: base,
    encoding,
    stats: () => ({
      spans: { ...stats.spans, ...spans.stats },
      logs: { ...stats.logs, ...logs.stats },
      metrics: { ...stats.metrics },
    }),
    handle,
  }
}
