import type { ReactNode } from 'react'

import type { EngineStatus, FnKind } from '../lib'

/** Method / kind / protocol tags and status pills — the workspace's color spine. */

const METHOD_TEXT: Readonly<Record<string, string>> = {
  GET: 'text-get',
  HEAD: 'text-get',
  POST: 'text-post',
  PUT: 'text-put',
  PATCH: 'text-patch',
  DELETE: 'text-delete',
}

const METHOD_DOT: Readonly<Record<string, string>> = {
  GET: 'bg-get',
  HEAD: 'bg-get',
  POST: 'bg-post',
  PUT: 'bg-put',
  PATCH: 'bg-patch',
  DELETE: 'bg-delete',
}

const METHOD_SHORT: Readonly<Record<string, string>> = {
  DELETE: 'DEL',
  PATCH: 'PTCH',
  OPTIONS: 'OPT',
  HEAD: 'HEAD',
}

const KIND_TEXT: Readonly<Record<FnKind, string>> = {
  query: 'text-query',
  mutation: 'text-mutation',
  action: 'text-action',
  stream: 'text-stream',
}

const KIND_DOT: Readonly<Record<FnKind, string>> = {
  query: 'bg-query',
  mutation: 'bg-mutation',
  action: 'bg-action',
  stream: 'bg-stream',
}

const PROTO_TEXT: Readonly<Record<ProtoName, string>> = {
  WS: 'text-socket',
  SSE: 'text-stream',
}

const PILL_TONE: Readonly<Record<PillTone, string>> = {
  ok: 'border-ok/50 bg-ok/10 text-ok',
  warn: 'border-post/50 bg-post/10 text-post',
  err: 'border-danger/50 bg-danger/10 text-danger',
  accent: 'border-accent/50 bg-accent/10 text-accent',
  muted: 'border-line text-muted',
}

const CONN_PILL: Readonly<
  Record<EngineStatus, { readonly tone: PillTone; readonly label: string }>
> = {
  idle: { tone: 'muted', label: 'idle' },
  connecting: { tone: 'warn', label: 'connecting' },
  open: { tone: 'ok', label: 'live' },
  reconnecting: { tone: 'warn', label: 'reconnecting' },
  closed: { tone: 'muted', label: 'closed' },
}

const TAG =
  'inline-flex w-10 shrink-0 items-center justify-end font-mono text-[10px] font-bold tracking-wider'

export type ProtoName = 'WS' | 'SSE'

export type PillTone = 'ok' | 'warn' | 'err' | 'accent' | 'muted'

export const methodTextClass = (method: string): string =>
  METHOD_TEXT[method.toUpperCase()] ?? 'text-muted'

export const methodDotClass = (method: string): string =>
  METHOD_DOT[method.toUpperCase()] ?? 'bg-muted'

export const methodShort = (method: string): string => {
  const upper = method.toUpperCase()

  return METHOD_SHORT[upper] ?? upper
}

export const kindDotClass = (kind: FnKind): string => KIND_DOT[kind]

export const protoDotClass = (proto: ProtoName): string =>
  proto === 'WS' ? 'bg-socket' : 'bg-stream'

/** Tone bucket of an HTTP status (2xx ok, 3xx accent, 4xx warn, 5xx err). */
export const statusTone = (status: number): PillTone => {
  if (status >= 500) {
    return 'err'
  }

  if (status >= 400) {
    return 'warn'
  }

  if (status >= 300) {
    return 'accent'
  }

  return 'ok'
}

/** Insomnia-style text-only method tag (GET green, POST orange, PUT blue, ...). */
export const MethodTag = ({ method }: { readonly method: string }) => (
  <span className={`${TAG} ${methodTextClass(method)}`}>{methodShort(method)}</span>
)

/** Kind tag for transport-internal functions without an HTTP route. */
export const KindTag = ({ kind }: { readonly kind: FnKind }) => (
  <span className={`${TAG} ${KIND_TEXT[kind]}`}>{kind.slice(0, 3).toUpperCase()}</span>
)

export const ProtoTag = ({ proto }: { readonly proto: ProtoName }) => (
  <span className={`${TAG} ${PROTO_TEXT[proto]}`}>{proto}</span>
)

export const KindBadge = ({ kind }: { readonly kind: FnKind }) => (
  <span
    className={`inline-flex items-center rounded-full border px-1.5 text-[10px] font-semibold tracking-wider uppercase ${KIND_TEXT[kind]} border-current/40`}>
    {kind}
  </span>
)

export const Pill = ({ children }: { readonly children: ReactNode }) => (
  <span className='border-line text-muted inline-flex items-center rounded-full border px-2 text-[11px] whitespace-nowrap'>
    {children}
  </span>
)

export const StatePill = ({
  tone,
  label,
  pulse = false,
}: {
  readonly tone: PillTone
  readonly label: string
  readonly pulse?: boolean
}) => (
  <span
    className={`inline-flex items-center rounded border px-1.5 py-px font-mono text-[11px] font-bold whitespace-nowrap ${PILL_TONE[tone]} ${pulse ? 'animate-pulse' : ''}`}>
    {label}
  </span>
)

export const ConnPill = ({ status }: { readonly status: EngineStatus }) => (
  <StatePill
    label={CONN_PILL[status].label}
    pulse={status === 'reconnecting' || status === 'connecting'}
    tone={CONN_PILL[status].tone}
  />
)
