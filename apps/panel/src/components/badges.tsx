import type { ReactNode } from 'react'

const METHOD_COLORS: Record<string, string> = {
  GET: 'var(--method-get)',
  POST: 'var(--method-post)',
  PUT: 'var(--method-put)',
  PATCH: 'var(--method-patch)',
  DELETE: 'var(--method-delete)',
}

const SHORT: Record<string, string> = { PATCH: 'PTCH', DELETE: 'DEL' }

export const MethodTag = ({ method, wide = false }: { method: string; wide?: boolean }) => (
  <span
    className='mono inline-block w-[38px] text-left text-[11px] font-bold'
    style={{ color: METHOD_COLORS[method] ?? 'var(--dim)', width: wide ? 'auto' : undefined }}>
    {wide ? method : (SHORT[method] ?? method)}
  </span>
)

export const WsTag = ({ label = 'WS' }: { label?: string }) => (
  <span className='mono inline-block w-[38px] text-[11px] font-bold' style={{ color: 'var(--ws)' }}>
    {label}
  </span>
)

export const KindTag = ({ kind }: { kind: string }) => (
  <span className='pill' style={{ background: 'var(--panel-2)', color: 'var(--dim)' }}>
    {kind}
  </span>
)

export const statusTone = (status: number | null, ok: boolean): string =>
  !ok || (status !== null && status >= 500)
    ? 'var(--bad)'
    : status !== null && status >= 400
      ? 'var(--warn)'
      : 'var(--ok)'

export const StatusPill = ({
  status,
  ok,
  label,
}: {
  status: number | null
  ok: boolean
  label?: string
}) => (
  <span className='pill' style={{ background: statusTone(status, ok), color: '#0f1115' }}>
    {label ?? status ?? (ok ? 'ok' : 'error')}
  </span>
)

export const Dim = ({ children }: { children: ReactNode }) => (
  <span style={{ color: 'var(--dim)' }}>{children}</span>
)
