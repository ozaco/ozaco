import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from 'react-aria-components'

import { CloseIcon } from './icons'

/** Minimal aria-live toast stack — errors announce assertively, info politely. */

interface Toast {
  readonly id: number
  readonly kind: ToastKind
  readonly text: string
}

const NOOP: ToastApi = {
  push: () => undefined,
  error: () => undefined,
  ok: () => undefined,
  info: () => undefined,
}

const ToastContext = createContext<ToastApi>(NOOP)

const TONE: Record<ToastKind, string> = {
  error: 'border-danger/50 text-danger',
  ok: 'border-ok/50 text-ok',
  info: 'border-line text-ink',
}

let toastSeq = 0

export type ToastKind = 'error' | 'ok' | 'info'

export interface ToastApi {
  readonly push: (kind: ToastKind, text: string) => void
  readonly error: (text: string) => void
  readonly ok: (text: string) => void
  readonly info: (text: string) => void
}

export const useToasts = (): ToastApi => useContext(ToastContext)

export const ToastProvider = ({ children }: { readonly children: ReactNode }) => {
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)

    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(id)
    }

    setToasts(prev => prev.filter(toast => toast.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      toastSeq += 1

      const id = toastSeq

      setToasts(prev => [...prev.slice(-4), { id, kind, text }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000),
      )
    },
    [dismiss],
  )

  useEffect(() => {
    const active = timers.current

    return () => {
      for (const timer of active.values()) {
        clearTimeout(timer)
      }

      active.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      push,
      error: text => push('error', text),
      ok: text => push('ok', text),
      info: text => push('info', text),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className='pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2'>
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`bg-panel pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] shadow-lg ${TONE[toast.kind]}`}
            {...(toast.kind === 'error' ? { role: 'alert' } : { role: 'status' })}>
            <span className='min-w-0 flex-1 break-words'>{toast.text}</span>
            <Button
              aria-label='Dismiss notification'
              className='text-muted data-hovered:text-ink shrink-0 rounded p-0.5'
              onPress={() => dismiss(toast.id)}>
              <CloseIcon />
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
