/**
 * The observe console: header (stats · filter · cluster · live dot) over a trace list (one ROOT
 * span per trace; live prepends + cursor-paged infinite scroll) and a detail pane (failures,
 * the span waterfall with events and log records inline; or the cluster view). All data rides
 * the `observe` service through `connectClient` — no hand-written bridge, no polling. The
 * opened trace is the url hash (`#trace=<id>`), so a link to another trace is a real navigation.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ClusterPane } from './components/cluster'
import { TraceDetail } from './components/detail'
import { TraceList } from './components/list'
import type { ClusterView, SpanRow, Stats, TraceView } from './lib/api'
import {
  failureOf,
  fetchCluster,
  fetchRequest,
  fetchStats,
  fetchTrace,
  fetchTraces,
  isRefused,
  liveBatches,
  setToken,
  storedToken,
} from './lib/api'
import { mergeLive } from './lib/trace'

type Pane =
  | { readonly kind: 'empty' }
  | { readonly kind: 'trace'; readonly view: TraceView; readonly focus: string | null }
  | { readonly kind: 'cluster'; readonly view: ClusterView }
  | { readonly kind: 'error'; readonly text: string }

const statsLine = (stats: Stats): string =>
  [
    `${stats.recorded} recorded`,
    `${stats.dropped} dropped`,
    `${stats.pending} pending`,
    stats.forwarded ? `${stats.forwarded} forwarded` : '',
    stats.received ? `${stats.received} received` : '',
  ]
    .filter(Boolean)
    .join(' · ')

const hashTrace = (): { traceId: string; spanId: string | null } | null => {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const traceId = params.get('trace')

  return traceId ? { traceId, spanId: params.get('span') } : null
}

export const App = () => {
  const [rows, setRows] = useState<readonly SpanRow[]>([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>({ kind: 'empty' })
  const [statsText, setStatsText] = useState('')
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const cursorRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  // the API refused us (`ObservePlugin.use({ auth })`): ask for a bearer token
  const [locked, setLocked] = useState(false)
  const [token, setTokenText] = useState('')

  /** A failed call: a refusal locks the console until a token is given. */
  const refused = useCallback((error: unknown): boolean => {
    const is = isRefused(error)

    if (is) {
      setLocked(true)
    }

    return is
  }, [])

  const more = useCallback(() => {
    if (busyRef.current || exhausted) {
      return
    }

    busyRef.current = true
    setLoading(true)

    void fetchTraces({ limit: 100, ...(cursorRef.current ? { cursor: cursorRef.current } : {}) })
      .then(page => {
        cursorRef.current = page.cursor
        setExhausted(page.cursor === null)
        // a page is older than what is listed: append the traces not listed yet
        setRows(prior => {
          const known = new Set(prior.map(row => row.trace_id))
          return [...prior, ...page.traces.filter(row => !known.has(row.trace_id))]
        })
        return page
      })
      .catch((error: unknown) => {
        refused(error)
        setExhausted(true)
      })
      .finally(() => {
        busyRef.current = false
        setLoading(false)
      })
  }, [exhausted, refused])

  const show = useCallback(
    (traceId: string, spanId: string | null) => {
      setSelected(traceId)
      void fetchTrace(traceId).then(
        view => setPane({ kind: 'trace', view, focus: spanId }),
        (error: unknown) => {
          refused(error)
          setPane({ kind: 'error', text: failureOf(error).tag })
        },
      )
    },
    [refused],
  )

  // the opened trace follows the url hash (links, back / forward)
  useEffect(() => {
    const follow = () => {
      const target = hashTrace()

      if (target) {
        show(target.traceId, target.spanId)
      }
    }

    follow()
    window.addEventListener('hashchange', follow)

    return () => window.removeEventListener('hashchange', follow)
  }, [show])

  // first page + the stats line
  useEffect(() => {
    more()
    void fetchStats()
      .then(stats => setStatsText(statsLine(stats)))
      .catch((error: unknown) => refused(error))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, [])

  // the live feed: prepend every batch; reconnect with a small delay when it drops
  useEffect(() => {
    let stopped = false
    let active: { cancel: () => unknown } | null = null

    void (async () => {
      // oxlint-disable no-await-in-loop -- one live feed at a time, reconnect after it drops
      for (;;) {
        try {
          const flow = await liveBatches()

          if (stopped) {
            await flow.cancel()
            return
          }

          active = flow
          setLive(true)

          for await (const batch of flow) {
            setRows(prior => mergeLive(prior, batch).slice(0, Math.max(500, prior.length)))
          }
        } catch (error) {
          // fall through to the retry below — a refusal waits for a token instead
          if (refused(error)) {
            return
          }
        }

        active = null
        setLive(false)

        if (stopped) {
          return
        }

        await new Promise(resolve => {
          setTimeout(resolve, 3000)
        })
      }
      // oxlint-enable no-await-in-loop
    })()

    return () => {
      stopped = true
      void active?.cancel()
    }
  }, [])

  const open = (traceId: string, spanId: string | null = null) => {
    const hash = `#trace=${traceId}${spanId ? `&span=${spanId}` : ''}`

    if (window.location.hash === hash) {
      show(traceId, spanId)
    } else {
      window.location.hash = hash
    }
  }

  /** Enter in the filter: look the text up as a request id (or a trace id). */
  const lookup = () => {
    const id = filter.trim()

    if (id.length === 0) {
      return
    }

    void fetchRequest(id).then(
      view => open(view.trace_id),
      (error: unknown) => {
        refused(error)
        setPane({ kind: 'error', text: `${failureOf(error).tag}: ${id}` })
      },
    )
  }

  const openCluster = () => {
    setSelected(null)
    void fetchCluster().then(
      view => setPane({ kind: 'cluster', view }),
      (error: unknown) => {
        refused(error)
        setPane({ kind: 'error', text: failureOf(error).tag })
      },
    )
  }

  /** Keep the token for this tab and start over with it. */
  const unlock = () => {
    setToken(token)
    window.location.reload()
  }

  return (
    <div className='flex h-full flex-col'>
      <header
        className='flex items-center gap-4 border-b px-4 py-2.5'
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <b style={{ color: 'var(--accent)' }}>ozaco</b> observe
        <span className='min-w-0 flex-1 truncate' style={{ color: 'var(--dim)' }}>
          {statsText}
        </span>
        <input
          className='input max-w-[360px] shrink-0'
          placeholder='filter: name, service, error… (enter: request id)'
          value={filter}
          onChange={event => setFilter(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              lookup()
            }
          }}
        />
        {locked && (
          <form
            className='flex shrink-0 items-center gap-2'
            onSubmit={event => {
              event.preventDefault()
              unlock()
            }}>
            <input
              className='input w-[220px]'
              type='password'
              autoComplete='off'
              placeholder={storedToken() ? 'token refused — another one' : 'bearer token'}
              value={token}
              onChange={event => setTokenText(event.target.value)}
            />
            <button className='btn' type='submit'>
              unlock
            </button>
          </form>
        )}
        <button className='btn' onClick={openCluster}>
          cluster
        </button>
        <span className='whitespace-nowrap' style={{ color: live ? 'var(--dim)' : 'var(--bad)' }}>
          {live ? '● live' : '○ offline'}
        </span>
      </header>
      <main className='grid min-h-0 flex-1 grid-cols-[minmax(340px,1fr)_2fr]'>
        <TraceList
          rows={rows}
          filter={filter.trim().toLowerCase()}
          selected={selected}
          exhausted={exhausted}
          loading={loading}
          onOpen={traceId => open(traceId)}
          onMore={more}
        />
        <section className='h-full overflow-auto'>
          {pane.kind === 'empty' && (
            <div className='p-6' style={{ color: 'var(--dim)' }}>
              {locked ? 'the observe API needs a bearer token (top right)' : 'pick a trace'}
            </div>
          )}
          {pane.kind === 'error' && (
            <div className='p-6' style={{ color: 'var(--bad)' }}>
              {pane.text}
            </div>
          )}
          {pane.kind === 'trace' && (
            <TraceDetail view={pane.view} focus={pane.focus} onOpenTrace={open} />
          )}
          {pane.kind === 'cluster' && <ClusterPane view={pane.view} />}
        </section>
      </main>
    </div>
  )
}
