import type { ServerDef, ServiceDef } from 'server:core'

export namespace AuditDef {
  /** Who is calling, in the terms an audit trail is read in: an application or a person both
   * arrive holding an access token — a `service` token is another system. */
  export type ActorType = 'anonymous' | 'service' | 'user'

  export interface Options {
    /** the logical stream the records go to (`ozaco.local.stream`). Default `'audit'`. */
    readonly stream?: string | undefined

    /** the action kinds audited. Default `['mutation', 'action']` — reads are left alone: a
     * record per page load buys nothing. */
    readonly only?: readonly ServiceDef.Kind[] | undefined

    /** leave a dispatch out (a telemetry sink's own writes, a health probe). */
    readonly skip?: ((call: ServerDef.Call, ctx: ServerDef.Ctx) => boolean) | undefined

    /** extra fields on every record (the tenant, a claim) — merged over the built-in ones. */
    readonly fields?:
      | ((call: ServerDef.Call, ctx: ServerDef.Ctx) => Readonly<Record<string, unknown>>)
      | undefined

    /** the record a write names, read off its input. Default: a string `id` field, else
     * `null` — the input itself is never repeated (the request's own span carries it). */
    readonly target?: ((input: unknown) => string | null) | undefined
  }

  /** One audit record, as `Server.actions.report` ships it (`Options.fields` adds to it). */
  export interface Entry {
    readonly stream: string
    readonly service: string
    readonly action: string
    readonly transport: string
    readonly actor: string | null
    readonly actor_type: ActorType
    readonly target: string | null
    readonly outcome: 'ok' | 'failed'
    readonly error: string | null
    readonly duration_ms: number
  }
}
