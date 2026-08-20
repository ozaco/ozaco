import type { AsyncSession, AsyncSseHandle } from '@ozaco/client'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextField,
} from 'react-aria-components'

import { StatePill } from '../components/badges'
import type { PillTone } from '../components/badges'
import {
  FIELD_INPUT,
  LISTBOX_ITEM,
  POPOVER,
  SELECT_BUTTON,
  SUB_PANEL,
  SUB_TAB,
  SUB_TAB_LIST,
  SectionTitle,
} from '../components/chrome'
import { ChevronIcon } from '../components/icons'
import { SplitLayout } from '../components/layout'
import { SchemaTree } from '../components/schema-tree'
import { messageOf } from '../components/session'
import { Timeline } from '../components/timeline'
import type { TimelineEntry, TimelineTone } from '../components/timeline'
import { useToasts } from '../components/toasts'
import { ActionButton, MethodChip, UrlBarShell } from '../components/url-bar'
import { realtimeServices, ssePathOf } from '../lib'
import type { Manifest } from '../lib'

/**
 * The SSE flavor of a realtime channel as a connectable request: Connect/Disconnect over
 * `GET <path>/sse?fn=&args=&since=`, with a color-coded event Timeline on the response side.
 *
 * The stream is the client's (`session.sse`), which reads it through `std:fetch` — that is what
 * lets the bearer token ride the Authorization header, which `EventSource` cannot do.
 */

type SseStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'failed'

const STATUS_PILL: Record<SseStatus, { readonly tone: PillTone; readonly label: string }> = {
  idle: { tone: 'muted', label: 'idle' },
  connecting: { tone: 'warn', label: 'connecting' },
  open: { tone: 'ok', label: 'live' },
  closed: { tone: 'muted', label: 'closed' },
  failed: { tone: 'err', label: 'failed' },
}

const FRAME_LIMIT = 300

const SERVER_FRAMES = ['sync', 'delta', 'reset', 'error'] as const

const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

const toneOfFrame = (value: unknown): TimelineTone => {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const type = (value as { readonly type: unknown }).type

    if (type === 'sync') {
      return 'sync'
    }

    if (type === 'delta') {
      return 'delta'
    }

    if (type === 'reset') {
      return 'reset'
    }

    if (type === 'error') {
      return 'err'
    }
  }

  return 'in'
}

export const SseTab = ({
  service,
  manifest,
  base,
  session,
  split,
  onSplit,
  stacked,
}: {
  readonly service: string
  readonly manifest: Manifest
  /** Display only — the session already knows where to dial. */
  readonly base: string
  readonly session: AsyncSession
  readonly split: number
  readonly onSplit: (pct: number) => void
  readonly stacked: boolean
}) => {
  const toasts = useToasts()
  const resource = useMemo(
    () => realtimeServices(manifest).find(candidate => candidate.service === service),
    [manifest, service],
  )

  const [path] = useState(() =>
    resource === undefined ? `/${service}/realtime/sse` : ssePathOf(resource.realtime),
  )
  const [fnKey, setFnKey] = useState(() => resource?.functions[0] ?? '')
  const [argsText, setArgsText] = useState('')
  const [since, setSince] = useState('')
  const [status, setStatus] = useState<SseStatus>('idle')
  const [frames, setFrames] = useState<readonly TimelineEntry[]>([])
  const streamRef = useRef<AsyncSseHandle | null>(null)

  useEffect(
    () => () => {
      const stream = streamRef.current

      streamRef.current = null
      void stream?.stop()
    },
    [],
  )

  const argsValid = useMemo((): boolean => {
    if (argsText.trim() === '') {
      return true
    }

    try {
      JSON.parse(argsText)

      return true
    } catch {
      return false
    }
  }, [argsText])

  const url = useMemo((): string => {
    const query = new URLSearchParams()

    query.set('fn', fnKey.trim())

    if (argsText.trim() !== '') {
      query.set('args', argsText.trim())
    }

    if (since.trim() !== '') {
      query.set('since', since.trim())
    }

    return `${base}${path}?${query.toString()}`
  }, [argsText, base, fnKey, path, since])

  const push = (tone: TimelineTone, text: string): void => {
    setFrames(prev => [...prev.slice(-(FRAME_LIMIT - 1)), { at: Date.now(), tone, text }])
  }

  const connected = status === 'connecting' || status === 'open'

  const disconnect = (): void => {
    const stream = streamRef.current

    streamRef.current = null
    void stream?.stop()
  }

  const connect = (): void => {
    if (fnKey.trim() === '') {
      toasts.error('Pick a function to watch first')

      return
    }

    if (!argsValid) {
      toasts.error('Watch args are not valid JSON')

      return
    }

    disconnect()
    setFrames([])
    setStatus('connecting')
    push('out', `GET ${url}`)

    void (async () => {
      try {
        streamRef.current = await session.sse({
          path,
          fn: fnKey.trim(),
          ...(argsText.trim() === '' ? {} : { args: JSON.parse(argsText) as unknown }),
          ...(since.trim() === '' ? {} : { since: Number(since.trim()) }),
          onValue: value => {
            setStatus('open')
            push(toneOfFrame(value), textOf(value))
          },
          onRaw: data => {
            setStatus('open')
            push('in', data)
          },
          onComment: comment => {
            setStatus('open')
            push('sys', `: ${comment}`)
          },
          onError: failure => {
            const message = messageOf(failure)

            setStatus('failed')
            push('err', message)
            toasts.error(`SSE stream failed: ${message}`)
          },
          onEnd: () => {
            setStatus(prev => (prev === 'failed' ? prev : 'closed'))
            push('sys', 'stream ended')
            streamRef.current = null
          },
        })
      } catch (error) {
        const message = messageOf(error)

        setStatus('failed')
        push('err', message)
        toasts.error(`SSE stream failed: ${message}`)
      }
    })()
  }

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <UrlBarShell>
        <MethodChip label='SSE' textClass='text-stream' />
        <div className='border-line bg-surface flex h-7 min-w-0 flex-1 items-center overflow-x-auto rounded border px-2.5 font-mono text-[12.5px] whitespace-nowrap'>
          {base === '' ? null : <span className='text-muted'>{base}</span>}
          <span className='text-ink'>{path}</span>
          <span className='text-muted'>
            ?fn={fnKey.trim()}
            {since.trim() === '' ? '' : `&since=${since.trim()}`}
          </span>
        </div>
        {connected ? (
          <ActionButton
            icon='stop'
            label='Disconnect'
            onPress={disconnect}
            tone={status === 'open' ? 'ok' : 'warn'}
          />
        ) : (
          <ActionButton icon='bolt' label='Connect' onPress={connect} tone='accent' />
        )}
      </UrlBarShell>

      <SplitLayout onSplit={onSplit} split={split} stacked={stacked}>
        <Tabs className='flex h-full min-h-0 flex-col' defaultSelectedKey='params'>
          <TabList aria-label='Stream sections' className={SUB_TAB_LIST}>
            <Tab className={SUB_TAB} id='params'>
              Params
            </Tab>
            <Tab className={SUB_TAB} id='docs'>
              Docs
            </Tab>
          </TabList>

          <TabPanel className={`${SUB_PANEL} p-3`} id='params'>
            <div className='flex max-w-md flex-col gap-3'>
              {resource !== undefined && resource.functions.length > 0 ? (
                <Select
                  className='flex flex-col gap-1'
                  onSelectionChange={key => setFnKey(String(key))}
                  selectedKey={fnKey === '' ? null : fnKey}>
                  <Label className='text-muted text-[12px] font-medium'>watched fn</Label>
                  <Button className={SELECT_BUTTON}>
                    <SelectValue />
                    <ChevronIcon className='text-muted rotate-90' />
                  </Button>
                  <Popover className={POPOVER}>
                    <ListBox
                      className='p-1 outline-none'
                      items={resource.functions.map(key => ({ id: key }))}>
                      {item => (
                        <ListBoxItem className={LISTBOX_ITEM} id={item.id} textValue={item.id}>
                          {item.id}
                        </ListBoxItem>
                      )}
                    </ListBox>
                  </Popover>
                </Select>
              ) : (
                <TextField className='flex flex-col gap-1' onChange={setFnKey} value={fnKey}>
                  <Label className='text-muted text-[12px] font-medium'>watched fn</Label>
                  <Input className={FIELD_INPUT} placeholder='function key to watch' />
                </TextField>
              )}

              <TextField
                aria-label='Watch arguments as JSON'
                className='flex flex-col gap-1'
                onChange={setArgsText}
                value={argsText}>
                <div className='flex items-baseline justify-between'>
                  <Label className='text-muted text-[12px] font-medium'>
                    args (json, optional)
                  </Label>
                  <span className={`text-[11.5px] ${argsValid ? 'text-muted' : 'text-danger'}`}>
                    {argsValid ? '' : 'invalid JSON'}
                  </span>
                </div>
                <TextArea
                  className='border-line bg-surface text-ink data-focused:border-accent min-h-16 w-full resize-y rounded border p-2.5 font-mono text-[12.5px] leading-5'
                  rows={3}
                  spellCheck={false}
                />
              </TextField>

              <TextField className='flex flex-col gap-1' onChange={setSince} value={since}>
                <Label className='text-muted text-[12px] font-medium'>since (optional)</Label>
                <Input className={FIELD_INPUT} placeholder='resume version, e.g. 42' />
              </TextField>

              <p className='text-muted text-[11.5px]'>
                Reconnecting with the last seen version resumes the stream; the opener comment{' '}
                <span className='font-mono'>: ok</span> confirms the subscription reached the edge.
              </p>
            </div>
          </TabPanel>

          <TabPanel className={`${SUB_PANEL} p-3`} id='docs'>
            {resource === undefined ? (
              <p className='text-muted text-[12.5px]'>
                This service no longer exposes a realtime channel in the current manifest.
              </p>
            ) : (
              <div className='flex flex-col gap-4'>
                <p className='text-muted text-[12.5px]'>
                  Server frames arrive as <span className='font-mono'>data:</span> lines — the same
                  sync/delta/reset/error vocabulary as the WebSocket flavor, one watch per
                  connection.
                </p>
                <div className='flex flex-col gap-1'>
                  <SectionTitle>Server frames</SectionTitle>
                  {SERVER_FRAMES.map(name => {
                    const schema = resource.realtime.server?.[name]

                    return schema === undefined ? null : (
                      <Fragment key={name}>
                        <span className='text-muted font-mono text-[11.5px]'>{name}</span>
                        <SchemaTree schema={schema} />
                      </Fragment>
                    )
                  })}
                </div>
              </div>
            )}
          </TabPanel>
        </Tabs>

        <div className='flex h-full min-h-0 flex-col'>
          <div className='border-line flex h-9 shrink-0 items-center gap-2 border-b px-2.5'>
            <StatePill
              label={STATUS_PILL[status].label}
              pulse={status === 'connecting'}
              tone={STATUS_PILL[status].tone}
            />
            <span className='text-muted text-[11.5px]'>{frames.length} events</span>
          </div>
          <div className='min-h-0 flex-1'>
            <Timeline empty='Connect to stream events into this timeline' entries={frames} />
          </div>
        </div>
      </SplitLayout>
    </div>
  )
}
