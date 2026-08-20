import type {
  AsyncRealtimeLink,
  AsyncSession,
  AsyncWatchHandle,
  FrameLog,
  LinkStatus,
} from '@ozaco/client'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  Cell,
  Column,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Row,
  Select,
  SelectValue,
  Tab,
  TabList,
  TabPanel,
  Table,
  TableBody,
  TableHeader,
  Tabs,
  TextArea,
  TextField,
} from 'react-aria-components'

import { ConnPill, Pill } from '../components/badges'
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
import { realtimeServices } from '../lib'
import type { Manifest } from '../lib'

/**
 * A WebSocket realtime channel as an Insomnia-style request: URL bar with the ws path and a
 * Connect/Disconnect toggle, Watch/Docs request sub-tabs, and a response side with the
 * materialized Live Rows table plus the color-coded frame Timeline.
 *
 * The socket, the `since`-resuming reconnect and the row materialization are ALL the client's
 * (`session.realtime`) — this view only renders the link's frame tap and its watch handle.
 */

const FRAME_LIMIT = 300

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Rows are `_id`-keyed exactly when EVERY row carries one — the client's own rule. */
const keyOf = (row: unknown): string | null =>
  isRecord(row) && typeof row['_id'] === 'string' ? row['_id'] : null

const rowKey = (row: unknown, index: number): string => keyOf(row) ?? `#${index}`

const toneOf = (entry: FrameLog): TimelineTone => {
  if (entry.dir !== 'in') {
    return entry.dir
  }

  if (entry.text.includes('"type":"sync"')) {
    return 'sync'
  }

  if (entry.text.includes('"type":"delta"')) {
    return 'delta'
  }

  if (entry.text.includes('"type":"reset"')) {
    return 'reset'
  }

  if (entry.text.includes('"type":"error"')) {
    return 'err'
  }

  return 'in'
}

const cellText = (value: unknown): string => {
  if (value === undefined) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  const text = JSON.stringify(value)

  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

interface RowItem {
  readonly key: string
  readonly cells: Readonly<Record<string, string>>
}

const CLIENT_FRAMES = ['watch', 'unwatch'] as const
const SERVER_FRAMES = ['sync', 'delta', 'reset', 'error'] as const

/** Render the declared frame schemas of a realtime block; absent ones are simply not listed. */
const frameSchemas = (
  block: Record<string, Record<string, unknown>> | undefined,
  names: readonly string[],
): ReactNode =>
  names.map(name => {
    const schema = block?.[name]

    return schema === undefined ? null : (
      <Fragment key={name}>
        <span className='text-muted font-mono text-[11.5px]'>{name}</span>
        <SchemaTree schema={schema} />
      </Fragment>
    )
  })

export const WsTab = ({
  service,
  manifest,
  base,
  session,
  split,
  onSplit,
  stacked,
}: {
  /** Realtime service name, or null for the custom-path pseudo entry. */
  readonly service: string | null
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
    () =>
      service === null
        ? undefined
        : realtimeServices(manifest).find(candidate => candidate.service === service),
    [manifest, service],
  )

  const [path, setPath] = useState(() => resource?.realtime.path ?? '/realtime')
  const [fnKey, setFnKey] = useState(() => resource?.functions[0] ?? '')
  const [argsText, setArgsText] = useState('')
  const [status, setStatus] = useState<LinkStatus>('idle')
  const [version, setVersion] = useState(-1)
  const [keyed, setKeyed] = useState(false)
  const [rows, setRows] = useState<readonly (readonly [string, unknown])[]>([])
  const [frames, setFrames] = useState<readonly TimelineEntry[]>([])
  const linkRef = useRef<AsyncRealtimeLink | null>(null)
  const watchRef = useRef<AsyncWatchHandle | null>(null)
  const untapRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      untapRef.current?.()

      const link = linkRef.current

      linkRef.current = null
      void link?.close()
    },
    [],
  )

  const argsValid = useMemo((): { readonly ok: boolean; readonly error: string } => {
    if (argsText.trim() === '') {
      return { ok: true, error: '' }
    }

    try {
      JSON.parse(argsText)

      return { ok: true, error: '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, [argsText])

  const parseWatchArgs = (): { readonly ok: boolean; readonly args: unknown } => {
    if (argsText.trim() === '') {
      return { ok: true, args: undefined }
    }

    try {
      return { ok: true, args: JSON.parse(argsText) }
    } catch {
      return { ok: false, args: undefined }
    }
  }

  const connected = status === 'connecting' || status === 'open' || status === 'reconnecting'

  const teardown = async (): Promise<void> => {
    untapRef.current?.()
    untapRef.current = null
    watchRef.current = null

    const link = linkRef.current

    linkRef.current = null

    if (link !== null) {
      await link.close()
    }
  }

  const disconnect = (): void => {
    void teardown().finally(() => {
      setStatus('closed')
    })
  }

  const startWatch = async (link: AsyncRealtimeLink): Promise<void> => {
    const fn = fnKey.trim()

    if (fn === '') {
      return
    }

    const watch = parseWatchArgs()

    if (!watch.ok) {
      toasts.error('Watch args are not valid JSON')

      return
    }

    setRows([])
    setVersion(-1)
    setKeyed(false)

    watchRef.current = await link.watch({
      fn,
      args: watch.args,
      onRows: (next, rowVersion) => {
        setRows(next.map((row, index) => [rowKey(row, index), row] as const))
        setKeyed(next.length > 0 && next.every(row => keyOf(row) !== null))
        setVersion(rowVersion)
      },
      options: {
        onError: failure => {
          toasts.error(messageOf(failure))
        },
      },
    })
  }

  const connect = (): void => {
    void (async () => {
      await teardown()
      setFrames([])

      try {
        // the client dials (and auto-reconnects with `since`); the tap is this view's timeline
        const link = await session.realtime({ path })

        linkRef.current = link
        untapRef.current = link.tap(frame => {
          setFrames(prev => [
            ...prev.slice(-(FRAME_LIMIT - 1)),
            { at: frame.at, tone: toneOf(frame), text: frame.text },
          ])
          setStatus(link.status())
        })
        setStatus(link.status())

        await startWatch(link)
        setStatus(link.status())
      } catch (error) {
        toasts.error(messageOf(error))
        setStatus('closed')
      }
    })()
  }

  const applyWatch = (): void => {
    void (async () => {
      const link = linkRef.current

      if (link === null) {
        toasts.error('Connect the socket first')

        return
      }

      const previous = watchRef.current

      watchRef.current = null

      // the link is pinned by `session.realtime`, so dropping the last watch keeps the socket
      if (previous !== null) {
        await previous.stop()
      }

      try {
        await startWatch(link)
      } catch (error) {
        toasts.error(messageOf(error))
      }
    })()
  }

  const columns = useMemo(() => {
    const keys: string[] = []
    let plain = false

    for (const [, row] of rows.slice(0, 50)) {
      if (isRecord(row)) {
        for (const key of Object.keys(row)) {
          if (!keys.includes(key)) {
            keys.push(key)
          }
        }
      } else {
        plain = true
      }
    }

    const named = keys.slice(0, 8).map(key => ({ id: key, name: key }))

    if (named.length === 0 || plain) {
      named.push({ id: '__value', name: 'value' })
    }

    return named
  }, [rows])

  const items = useMemo<readonly RowItem[]>(
    () =>
      rows.map(([key, row]) => {
        const cells: Record<string, string> = {}

        for (const column of columns) {
          cells[column.id] =
            column.id === '__value'
              ? isRecord(row)
                ? ''
                : cellText(row)
              : isRecord(row)
                ? cellText(row[column.id])
                : ''
        }

        return { key, cells }
      }),
    [rows, columns],
  )

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <UrlBarShell>
        <MethodChip label='WS' textClass='text-socket' />
        {resource === undefined ? (
          <TextField
            aria-label='WebSocket path'
            className='min-w-0 flex-1'
            isDisabled={connected}
            onChange={setPath}
            value={path}>
            <Label className='sr-only'>WebSocket path</Label>
            <Input className='border-line bg-surface text-ink data-focused:border-accent h-7 w-full rounded border px-2.5 font-mono text-[12.5px]' />
          </TextField>
        ) : (
          <div className='border-line bg-surface flex h-7 min-w-0 flex-1 items-center overflow-x-auto rounded border px-2.5 font-mono text-[12.5px] whitespace-nowrap'>
            {base === '' ? null : <span className='text-muted'>{base}</span>}
            <span className='text-ink'>{path}</span>
          </div>
        )}
        {connected ? (
          <ActionButton
            icon='stop'
            label={status === 'open' ? 'Disconnect' : 'Stop'}
            onPress={disconnect}
            tone={status === 'open' ? 'ok' : 'warn'}
          />
        ) : (
          <ActionButton icon='bolt' label='Connect' onPress={connect} tone='accent' />
        )}
      </UrlBarShell>

      <SplitLayout onSplit={onSplit} split={split} stacked={stacked}>
        <Tabs className='flex h-full min-h-0 flex-col' defaultSelectedKey='watch'>
          <TabList aria-label='Watch sections' className={SUB_TAB_LIST}>
            <Tab className={SUB_TAB} id='watch'>
              Watch
            </Tab>
            <Tab className={SUB_TAB} id='docs'>
              Docs
            </Tab>
          </TabList>

          <TabPanel className={`${SUB_PANEL} p-3`} id='watch'>
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
                  <span className={`text-[11.5px] ${argsValid.ok ? 'text-muted' : 'text-danger'}`}>
                    {argsValid.error}
                  </span>
                </div>
                <TextArea
                  className='border-line bg-surface text-ink data-focused:border-accent min-h-16 w-full resize-y rounded border p-2.5 font-mono text-[12.5px] leading-5'
                  rows={3}
                  spellCheck={false}
                />
              </TextField>

              <div className='flex items-center gap-2'>
                <Button
                  className='border-accent/60 text-accent data-hovered:bg-accent/10 rounded border px-2.5 py-1 text-[12px] font-medium data-disabled:opacity-40'
                  isDisabled={!argsValid.ok || fnKey.trim() === ''}
                  onPress={applyWatch}>
                  {connected ? 'Restart watch' : 'Watch on connect'}
                </Button>
                <Pill>{version >= 0 ? `since v${version}` : 'no version yet'}</Pill>
              </div>

              <p className='text-muted text-[11.5px]'>
                Reconnects resume with <span className='font-mono'>since</span>; a server{' '}
                <span className='font-mono'>reset</span> resubscribes fresh. Auth rides{' '}
                <span className='font-mono'>?token=</span> on the upgrade.
              </p>
            </div>
          </TabPanel>

          <TabPanel className={`${SUB_PANEL} p-3`} id='docs'>
            {resource === undefined ? (
              <p className='text-muted text-[12.5px]'>
                Custom socket — no manifest schema. Frames follow the realtime vocabulary:
                watch/unwatch out, sync/delta/reset/error in.
              </p>
            ) : (
              <div className='flex flex-col gap-4'>
                <div className='flex flex-col gap-1'>
                  <SectionTitle>Client frames</SectionTitle>
                  {frameSchemas(resource.realtime.client, CLIENT_FRAMES)}
                </div>
                <div className='flex flex-col gap-1'>
                  <SectionTitle>Server frames</SectionTitle>
                  {frameSchemas(resource.realtime.server, SERVER_FRAMES)}
                </div>
              </div>
            )}
          </TabPanel>
        </Tabs>

        <div className='flex h-full min-h-0 flex-col'>
          <div className='border-line flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b px-2.5'>
            <ConnPill status={status} />
            <Pill>{version >= 0 ? `v${version}` : 'no sync yet'}</Pill>
            <Pill>{rows.length} rows</Pill>
            {rows.length > 0 ? <Pill>{keyed ? '_id-keyed' : 'synthetic keys'}</Pill> : null}
          </div>

          <Tabs className='flex min-h-0 flex-1 flex-col' defaultSelectedKey='rows'>
            <TabList aria-label='Live sections' className={SUB_TAB_LIST}>
              <Tab className={SUB_TAB} id='rows'>
                Live Rows
              </Tab>
              <Tab className={SUB_TAB} id='timeline'>
                Timeline
              </Tab>
            </TabList>

            <TabPanel className={SUB_PANEL} id='rows'>
              <Table aria-label='Materialized rows' className='w-full text-[12.5px]'>
                <TableHeader columns={columns}>
                  {column => (
                    <Column
                      className='border-line text-muted bg-panel sticky top-0 border-b px-2 py-1 text-left text-[11px] font-semibold tracking-wider uppercase'
                      id={column.id}
                      isRowHeader={column.id === columns[0]?.id}>
                      {column.name}
                    </Column>
                  )}
                </TableHeader>
                <TableBody
                  items={items}
                  renderEmptyState={() => (
                    <div className='text-muted p-3 text-[12.5px]'>
                      No rows yet — connect and watch to stream sync/delta frames into this table.
                    </div>
                  )}>
                  {item => (
                    <Row
                      className='data-hovered:bg-card border-line border-b last:border-b-0'
                      columns={columns}
                      id={item.key}>
                      {column => (
                        <Cell className='text-ink max-w-64 truncate px-2 py-1 font-mono'>
                          {item.cells[column.id] ?? ''}
                        </Cell>
                      )}
                    </Row>
                  )}
                </TableBody>
              </Table>
            </TabPanel>

            <TabPanel className={SUB_PANEL} id='timeline'>
              <Timeline empty='Frames appear here once connected' entries={frames} />
            </TabPanel>
          </Tabs>
        </div>
      </SplitLayout>
    </div>
  )
}
