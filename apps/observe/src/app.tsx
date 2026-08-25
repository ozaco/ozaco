/**
 * The observe console: header (stats · filter · cluster · live dot) over a request list
 * (live prepends + cursor-paged infinite scroll) and a detail pane (span waterfall, failures,
 * logs, events; or the cluster view). All data rides the `observe` service through
 * `connectClient` — no hand-written bridge, no polling.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ClusterPane } from './components/cluster'
import { RequestDetail } from './components/detail'
import { RequestList } from './components/list'
import type { ClusterView, RequestRow, RequestView } from './lib/api'
import {
  failureOf,
  fetchCluster,
  fetchRequest,
  fetchRequests,
  fetchStats,
  liveBatches,
} from './lib/api'

type Pane =
  | { readonly kind: 'empty' }
  | { readonly kind: 'request'; readonly view: RequestView }
  | { readonly kind: 'cluster'; readonly view: ClusterView }
  | { readonly kind: 'error'; readonly text: string }

export const App = () => {
  const [rows, setRows] = useState<readonly RequestRow[]>([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>({ kind: 'empty' })
  const [statsText, setStatsText] = useState('')
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const cursorRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  const more = useCallback(() => {
    if (busyRef.current || exhausted) {
      return
    }

    busyRef.current = true
    setLoading(true)

    void fetchRequests({ limit: 100, ...(cursorRef.current ? { cursor: cursorRef.current } : {}) })
      .then(page => {
        cursorRef.current = page.cursor
        setExhausted(page.cursor === null)
        setRows(prior => {
          const seen = new Set(prior.map(row => row.request_id))
          return [...prior, ...page.requests.filter(row => !seen.has(row.request_id))]
        })
        return page
      })
      .catch(() => setExhausted(true))
      .finally(() => {
        busyRef.current = false
        setLoading(false)
      })
  }, [exhausted])

  // first page + the stats line
  useEffect(() => {
    more()
    void fetchStats()
      .then(stats => setStatsText(JSON.stringify(stats)))
      .catch(() => {})
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
            setRows(prior => {
              const cap = Math.max(500, prior.length)
              const incoming = new Set(batch.map(row => row.request_id))
              return [...batch, ...prior.filter(row => !incoming.has(row.request_id))].slice(0, cap)
            })
          }
        } catch {
          // fall through to the retry below
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

  const open = (requestId: string) => {
    setSelected(requestId)
    void fetchRequest(requestId).then(
      view => setPane({ kind: 'request', view }),
      (error: unknown) => setPane({ kind: 'error', text: failureOf(error).tag }),
    )
  }

  const openCluster = () => {
    setSelected(null)
    void fetchCluster().then(
      view => setPane({ kind: 'cluster', view }),
      (error: unknown) => setPane({ kind: 'error', text: failureOf(error).tag }),
    )
  }

  return (
    <div className='flex h-full flex-col'>
      <header
        className='flex items-center gap-4 border-b px-4 py-2.5'
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <b style={{ color: 'var(--accent)' }}>ozaco</b> observe
        <span className='truncate' style={{ color: 'var(--dim)' }}>
          {statsText}
        </span>
        <input
          className='input ml-auto w-[280px]'
          placeholder='filter: service, action, tag…'
          value={filter}
          onChange={event => setFilter(event.target.value)}
        />
        <button className='btn' onClick={openCluster}>
          cluster
        </button>
        <span style={{ color: live ? 'var(--dim)' : 'var(--bad)' }}>
          {live ? '● live' : '○ offline'}
        </span>
      </header>
      <main className='grid min-h-0 flex-1 grid-cols-[minmax(320px,1fr)_2fr]'>
        <RequestList
          rows={rows}
          filter={filter.trim().toLowerCase()}
          selected={selected}
          exhausted={exhausted}
          loading={loading}
          onOpen={open}
          onMore={more}
        />
        <section className='h-full overflow-auto'>
          {pane.kind === 'empty' && (
            <div className='p-6' style={{ color: 'var(--dim)' }}>
              pick a request
            </div>
          )}
          {pane.kind === 'error' && (
            <div className='p-6' style={{ color: 'var(--bad)' }}>
              {pane.text}
            </div>
          )}
          {pane.kind === 'request' && <RequestDetail view={pane.view} />}
          {pane.kind === 'cluster' && <ClusterPane view={pane.view} />}
        </section>
      </main>
    </div>
  )
}
