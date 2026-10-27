import type { ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { attempt } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import pkg from '../../../package.json'

import type { AuditDef } from './types'

const actorTypeOf = (ctx: ServerDef.Ctx): AuditDef.ActorType => {
  if (!ctx.auth) {
    return 'anonymous'
  }

  return ctx.auth.type === 'service' ? 'service' : 'user'
}

const targetOf = (input: unknown): string | null =>
  typeof input === 'object' && input !== null && 'id' in input && typeof input.id === 'string'
    ? input.id
    : null

/**
 * WHO did WHAT, for every write this node answers — as a domain record (`Server.actions.report`,
 * stream `audit`) on the dispatch's own span, in front of the same exporters as everything else:
 * the kernel records every request and failure, none of that carries a principal. Both outcomes
 * ship (a refused write is the interesting half of a trail). Install it AFTER `Auth`: the auth
 * plugin hands its principal to the layers inside it — a call Auth itself rejects never reaches
 * here (it is a 401 / 403 on the request's own trace).
 */
export const Audit = definePlugin<ServerDef.PluginContext, [options?: AuditDef.Options]>({
  name: 'server-audit',
  version: pkg.version,
  description: 'Every write as an audit record on the observe spine',

  *setup(options) {
    if (!(yield* Server.context.get())) {
      return yield* fail(
        ServerErrors.Configuration,
        'Audit must be installed by Server.actions.create (after Auth)',
      )
    }

    const stream = options?.stream ?? 'audit'
    const only = new Set(options?.only ?? ['mutation', 'action'])
    const target = options?.target ?? targetOf

    return {
      hooks: {
        name: 'audit',
        *dispatch(call, ctx, next) {
          if (!only.has(ctx.meta.kind) || options?.skip?.(call, ctx)) {
            return yield* next(call, ctx)
          }

          const started = Date.now()
          const outcome = yield* attempt(() => next(call, ctx))
          const failed = isFailure(outcome)
          const entry: AuditDef.Entry = {
            stream,
            service: call.service,
            action: call.action,
            transport: call.transport,
            actor: ctx.auth?.sub ?? null,
            actor_type: actorTypeOf(ctx),
            target: target(call.input),
            outcome: failed ? 'failed' : 'ok',
            error: failed ? String(outcome.error) : null,
            duration_ms: Date.now() - started,
          }

          yield* Server.actions.report({ ...entry, ...options?.fields?.(call, ctx) })

          return failed ? yield* outcome : outcome.value
        },
      },
    }
  },
}).build()
