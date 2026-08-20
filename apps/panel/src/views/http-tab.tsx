import { createSseParser } from '@ozaco/client'
import type { AsyncSession, RequestHandle } from '@ozaco/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Dialog,
  DialogTrigger,
  Input,
  Label,
  Popover,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextField,
} from 'react-aria-components'

import {
  KindBadge,
  Pill,
  StatePill,
  methodShort,
  methodTextClass,
  statusTone,
} from '../components/badges'
import { FIELD_INPUT, SUB_PANEL, SUB_TAB, SUB_TAB_LIST, SectionTitle } from '../components/chrome'
import { CopyButton } from '../components/copy'
import { FileAttach } from '../components/file-attach'
import { ClockIcon } from '../components/icons'
import { JsonTree } from '../components/json-tree'
import { KvEditor, kvToRecord } from '../components/kv-editor'
import type { KvRow } from '../components/kv-editor'
import { SplitLayout } from '../components/layout'
import { SchemaTree } from '../components/schema-tree'
import { messageOf } from '../components/session'
import { Timeline } from '../components/timeline'
import type { TimelineEntry, TimelineTone } from '../components/timeline'
import { useToasts } from '../components/toasts'
import { ActionButton, MethodChip, PathDisplay, UrlBarShell } from '../components/url-bar'
import { formatBytes, getToken, skeletonOf, walkSchema } from '../lib'
import type { FnEntry, ResponseKind, UploadFile } from '../lib'

/**
 * One HTTP request tab: URL bar (method + path + Send/Cancel) over the request | response dual
 * pane. Request sub-tabs: Params / Body / Files / Headers / Auth / Docs; response sub-tabs:
 * Body / Headers / Timeline with a status header and per-tab run history. All state lives here,
 * so it survives tab switches while the tab stays open.
 *
 * Addressing, auth, multipart framing and the round trip are the client's (`session.request`):
 * it answers with the full response metadata and an UNREAD body, which is what lets this view
 * stream ndjson/sse/bytes instead of parsing eagerly. Cancel halts the request's task.
 */

/** `:param` segments filled from args — the same resolution the URL bar renders. */
const resolvePath = (path: string, args: Readonly<Record<string, unknown>>): string =>
  path.replaceAll(/:([A-Za-z0-9_]+)/gu, (whole, name: string) => {
    const value = args[name]

    return value === undefined ? whole : encodeURIComponent(String(value))
  })

type ParsedArgs =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly wrapped: boolean }
  | { readonly ok: false; readonly error: string }

type RunPhase = 'running' | 'streaming' | 'done' | 'failed' | 'aborted'

interface HttpRun {
  readonly phase: RunPhase
  readonly status: number | null
  readonly ok: boolean
  readonly statusText: string
  readonly requestId: string | null
  readonly kind: ResponseKind | null
  readonly headers: readonly (readonly [string, string])[]
  readonly headerMs: number | null
  readonly totalMs: number | null
  readonly size: number | null
  readonly text: string | null
  readonly lines: readonly TimelineEntry[]
  readonly bytes: { readonly size: number; readonly hex: string } | null
  readonly failure: string | null
}

interface RunRecord {
  readonly id: number
  readonly at: number
  readonly status: number | null
  readonly ok: boolean
  readonly ms: number | null
  readonly argsText: string
  readonly fileCount: number
  readonly requestId: string | null
}

interface ArgField {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly inPath: boolean
}

const IDLE_RUN: HttpRun = {
  phase: 'done',
  status: null,
  ok: false,
  statusText: '',
  requestId: null,
  kind: null,
  headers: [],
  headerMs: null,
  totalMs: null,
  size: null,
  text: null,
  lines: [],
  bytes: null,
  failure: null,
}

const HISTORY_LIMIT = 20
const LINE_LIMIT = 500
const HEX_BYTES = 256

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseArgs = (raw: string): ParsedArgs => {
  const trimmed = raw.trim()

  if (trimmed === '') {
    return { ok: true, value: {}, wrapped: false }
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)

    return isRecord(parsed)
      ? { ok: true, value: parsed, wrapped: false }
      : { ok: true, value: { body: parsed }, wrapped: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const pathParams = (path: string): string[] =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/gu)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined)

const hexPreview = (bytes: Uint8Array): string => {
  const shown = bytes.slice(0, HEX_BYTES)
  const rows: string[] = []

  for (let offset = 0; offset < shown.length; offset += 16) {
    rows.push(
      Array.from(shown.slice(offset, offset + 16))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(' '),
    )
  }

  return rows.join('\n') + (bytes.length > HEX_BYTES ? '\n…' : '')
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length

const argText = (value: unknown): string => {
  if (value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Schema-typed strings stay raw text; everything else parses as JSON when possible. */
const coerceArg = (text: string, schemaType: string): unknown => {
  if (schemaType === 'string') {
    return text
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

let recordSeq = 0

export const HttpTab = ({
  entry,
  base,
  session,
  split,
  onSplit,
  stacked,
  onOpenSettings,
}: {
  readonly entry: FnEntry
  /** Display only — the session already knows where to send. */
  readonly base: string
  readonly session: AsyncSession
  readonly split: number
  readonly onSplit: (pct: number) => void
  readonly stacked: boolean
  readonly onOpenSettings: () => void
}) => {
  const toasts = useToasts()
  const [argsText, setArgsText] = useState(() => JSON.stringify(skeletonOf(entry.args), null, 2))
  const [files, setFiles] = useState<readonly UploadFile[]>([])
  const [headerRows, setHeaderRows] = useState<readonly KvRow[]>([])
  const [authOverride, setAuthOverride] = useState('')
  const [run, setRun] = useState<HttpRun | null>(null)
  const [history, setHistory] = useState<readonly RunRecord[]>([])
  const [reqTab, setReqTab] = useState('params')
  const [bodyView, setBodyView] = useState<'pretty' | 'raw'>('pretty')
  // display only: the session resolves the live token itself on every request
  const globalToken = getToken()
  const inflight = useRef<{ handle: RequestHandle; cancelled: boolean } | null>(null)
  const runSeq = useRef(0)

  useEffect(
    () => () => {
      const current = inflight.current

      inflight.current = null

      if (current !== null) {
        current.cancelled = true
        void current.handle.cancel()
      }
    },
    [],
  )

  const route = entry.route
  const parsed = parseArgs(argsText)
  const parsedArgs = parsed.ok ? parsed.value : null
  const running = run !== null && (run.phase === 'running' || run.phase === 'streaming')
  const sse = route?.sse === true

  const fields = useMemo((): readonly ArgField[] => {
    const params = new Set(route === undefined ? [] : pathParams(route.path))
    const list: ArgField[] = []
    const seen = new Set<string>()

    for (const child of walkSchema(entry.args).children) {
      if (child.name !== undefined) {
        seen.add(child.name)
        list.push({
          name: child.name,
          type: child.type,
          required: child.required,
          inPath: params.has(child.name),
        })
      }
    }

    for (const name of params) {
      if (!seen.has(name)) {
        seen.add(name)
        list.push({ name, type: 'string', required: true, inPath: true })
      }
    }

    if (parsedArgs !== null) {
      for (const name of Object.keys(parsedArgs)) {
        if (!seen.has(name)) {
          list.push({ name, type: 'json', required: false, inPath: false })
        }
      }
    }

    return [...list.filter(field => field.inPath), ...list.filter(field => !field.inPath)]
  }, [entry.args, parsedArgs, route])

  const updateArg = (name: string, text: string, schemaType: string): void => {
    if (parsedArgs === null) {
      return
    }

    const next: Record<string, unknown> =
      text === ''
        ? Object.fromEntries(Object.entries(parsedArgs).filter(([key]) => key !== name))
        : { ...parsedArgs, [name]: coerceArg(text, schemaType) }

    setArgsText(JSON.stringify(next, null, 2))
  }

  const patch = (id: number, update: (prev: HttpRun) => HttpRun): void => {
    if (runSeq.current === id) {
      setRun(prev => (prev === null ? prev : update(prev)))
    }
  }

  const pushLine = (id: number, tone: TimelineTone, text: string): void => {
    patch(id, prev => ({
      ...prev,
      lines: [...prev.lines.slice(-(LINE_LIMIT - 1)), { at: Date.now(), tone, text }],
    }))
  }

  const cancel = (): void => {
    const current = inflight.current

    if (current !== null) {
      current.cancelled = true
      void current.handle.cancel()
    }
  }

  const send = async (raw: string): Promise<void> => {
    if (route === undefined) {
      return
    }

    const args = parseArgs(raw)

    if (!args.ok) {
      toasts.error(`Args are not valid JSON: ${args.error}`)

      return
    }

    cancel()
    runSeq.current += 1

    const id = runSeq.current
    const override = authOverride.trim()
    const handle = session.request({
      resource: entry.service,
      fn: entry.key,
      args: args.value,
      files: files.map(upload => ({ field: upload.field, file: upload.file })),
      headers: {
        ...kvToRecord(headerRows),
        // an explicit Auth override beats the session's own token resolver
        ...(override === '' ? {} : { authorization: `Bearer ${override}` }),
      },
    })
    const record = { handle, cancelled: false }

    inflight.current = record

    setRun({
      ...IDLE_RUN,
      phase: 'running',
      lines: [
        {
          at: Date.now(),
          tone: 'out',
          text: `${route.method.toUpperCase()} ${base}${resolvePath(route.path, args.value)}`,
        },
      ],
    })

    const started = performance.now()

    const finish = (phase: RunPhase, size: number | null): void => {
      const totalMs = Math.round(performance.now() - started)

      patch(id, prev => ({ ...prev, phase, totalMs, size }))

      if (phase === 'done') {
        pushLine(id, 'sys', `done · ${totalMs}ms${size === null ? '' : ` · ${formatBytes(size)}`}`)
      }
    }

    try {
      const executed = await handle.done
      const headerMs = Math.round(performance.now() - started)

      patch(id, prev => ({
        ...prev,
        status: executed.status,
        ok: executed.ok,
        statusText: executed.statusText,
        requestId: executed.requestId,
        kind: executed.kind,
        headers: [...executed.headers.entries()],
        headerMs,
      }))
      pushLine(
        id,
        executed.ok ? 'sys' : 'err',
        `HTTP ${executed.status} ${executed.statusText} · ${executed.kind} · ${headerMs}ms`,
      )

      recordSeq += 1
      setHistory(prev =>
        [
          {
            id: recordSeq,
            at: Date.now(),
            status: executed.status,
            ok: executed.ok,
            ms: headerMs,
            argsText: raw,
            fileCount: files.length,
            requestId: executed.requestId,
          },
          ...prev,
        ].slice(0, HISTORY_LIMIT),
      )

      if (executed.kind === 'json' || executed.kind === 'text') {
        const text = await executed.native.text()

        patch(id, prev => ({ ...prev, text }))
        finish('done', byteLength(text))

        return
      }

      if (executed.kind === 'bytes') {
        const buffer = await executed.native.arrayBuffer()
        const bytes = new Uint8Array(buffer)

        patch(id, prev => ({ ...prev, bytes: { size: bytes.length, hex: hexPreview(bytes) } }))
        finish('done', bytes.length)

        return
      }

      const body = executed.native.body

      if (body === null) {
        finish('done', null)

        return
      }

      patch(id, prev => ({ ...prev, phase: 'streaming' }))

      const reader = body.getReader()
      let received = 0

      if (executed.kind === 'sse') {
        const parser = createSseParser({
          onData: data => pushLine(id, 'in', data),
          onComment: comment => pushLine(id, 'sys', `: ${comment}`),
        })

        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- stream chunks are inherently sequential
          const step = await reader.read()

          if (step.done) {
            parser.end()
            break
          }

          received += step.value.length
          parser.push(step.value)
        }

        finish('done', received)

        return
      }

      // ndjson — decode and emit line by line
      const decoder = new TextDecoder()
      let buffered = ''

      const emit = (chunk: string): void => {
        buffered += chunk

        for (;;) {
          const newline = buffered.indexOf('\n')

          if (newline === -1) {
            return
          }

          const line = buffered.slice(0, newline).replace(/\r$/u, '')

          buffered = buffered.slice(newline + 1)

          if (line !== '') {
            pushLine(id, 'in', line)
          }
        }
      }

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- stream chunks are inherently sequential
        const step = await reader.read()

        if (step.done) {
          emit(decoder.decode())

          if (buffered.trim() !== '') {
            pushLine(id, 'in', buffered.trim())
          }

          break
        }

        received += step.value.length
        emit(decoder.decode(step.value, { stream: true }))
      }

      finish('done', received)
    } catch (error) {
      if (record.cancelled) {
        pushLine(id, 'err', 'cancelled')
        finish('aborted', null)

        return
      }

      const message = messageOf(error)

      patch(id, prev => ({ ...prev, failure: `Request failed: ${message}` }))
      pushLine(id, 'err', message)
      finish('failed', null)
      toasts.error(`Request failed: ${message}`)
    } finally {
      // the response body is readable only while the handle is open — release it once read
      if (inflight.current === record) {
        inflight.current = null
      }

      await handle.close()
    }
  }

  const rerun = (record: RunRecord): void => {
    setArgsText(record.argsText)
    void send(record.argsText)
  }

  const parsedBody = useMemo((): unknown => {
    if (run === null || run.kind !== 'json' || run.text === null) {
      return undefined
    }

    try {
      return JSON.parse(run.text) as unknown
    } catch {
      return undefined
    }
  }, [run])

  const errors = Object.entries(entry.errors)

  const docsPanel = (
    <div className='flex flex-col gap-4 p-3'>
      <div className='flex flex-col gap-1.5'>
        <div className='flex items-center gap-2'>
          <span className='text-ink font-mono text-[12.5px]'>{entry.id}</span>
          <CopyButton label='Copy function id' text={entry.id} />
          <KindBadge kind={entry.kind} />
        </div>
        {entry.title === undefined ? null : (
          <p className='text-ink text-[13px] font-medium'>{entry.title}</p>
        )}
        {entry.description === undefined ? null : (
          <p className='text-muted text-[13px]'>{entry.description}</p>
        )}
      </div>

      <div className='flex flex-col gap-1'>
        <SectionTitle>Wire</SectionTitle>
        <div className='text-muted font-mono text-[12px]'>
          {route === undefined
            ? 'no HTTP route — transport-internal'
            : `${route.method.toUpperCase()} ${route.path}${sse ? ' · sse' : ''}`}
        </div>
        <div className='text-muted font-mono text-[12px]'>
          in: {entry.channels.input.join(', ')} → out: {entry.channels.output.join(', ')}
        </div>
      </div>

      {entry.tags.length === 0 ? null : (
        <div className='flex flex-wrap gap-1.5'>
          {entry.tags.map(tag => (
            <Pill key={tag}>{tag}</Pill>
          ))}
        </div>
      )}

      {errors.length === 0 ? null : (
        <div className='flex flex-col gap-1'>
          <SectionTitle>Errors</SectionTitle>
          <table className='w-full border-collapse text-[12.5px]'>
            <tbody>
              {errors.map(([tag, { status }]) => (
                <tr key={tag}>
                  <td className='border-line text-ink border-b px-2 py-0.5 font-mono'>{tag}</td>
                  <td className='border-line border-b px-2 py-0.5 font-mono'>
                    <span className={status >= 500 ? 'text-danger' : 'text-post'}>{status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entry.args === undefined ? null : (
        <div className='flex flex-col gap-1'>
          <SectionTitle>Args</SectionTitle>
          <SchemaTree schema={entry.args} />
        </div>
      )}

      {entry.returns === undefined ? null : (
        <div className='flex flex-col gap-1'>
          <SectionTitle>Returns</SectionTitle>
          <SchemaTree schema={entry.returns} />
        </div>
      )}
    </div>
  )

  if (route === undefined) {
    return (
      <div className='flex h-full min-h-0 flex-col'>
        <UrlBarShell>
          <MethodChip label={entry.kind.toUpperCase()} textClass='text-muted' />
          <div className='text-muted flex-1 truncate font-mono text-[12.5px]'>
            no HTTP route — transport-internal function
          </div>
        </UrlBarShell>
        <div className='min-h-0 flex-1 overflow-y-auto'>{docsPanel}</div>
      </div>
    )
  }

  const streamedRun = run !== null && (run.kind === 'sse' || run.kind === 'ndjson')
  const dataLines = run === null ? [] : run.lines.filter(line => line.tone === 'in')

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <UrlBarShell>
        <MethodChip label={methodShort(route.method)} textClass={methodTextClass(route.method)} />
        <PathDisplay args={parsedArgs} base={base} path={route.path} />
        {running ? (
          <ActionButton
            icon='stop'
            label={sse ? 'Disconnect' : 'Cancel'}
            onPress={cancel}
            tone='danger'
          />
        ) : (
          <ActionButton
            icon='play'
            isDisabled={!parsed.ok}
            label={sse ? 'Connect' : 'Send'}
            onPress={() => {
              void send(argsText)
            }}
            tone='accent'
          />
        )}
      </UrlBarShell>

      <SplitLayout onSplit={onSplit} split={split} stacked={stacked}>
        <Tabs
          className='flex h-full min-h-0 flex-col'
          onSelectionChange={key => setReqTab(String(key))}
          selectedKey={reqTab}>
          <TabList aria-label='Request sections' className={SUB_TAB_LIST}>
            <Tab className={SUB_TAB} id='params'>
              Params
            </Tab>
            <Tab className={SUB_TAB} id='body'>
              Body
            </Tab>
            <Tab className={SUB_TAB} id='files'>
              Files{files.length > 0 ? ` (${files.length})` : ''}
            </Tab>
            <Tab className={SUB_TAB} id='headers'>
              Headers{headerRows.length > 0 ? ` (${headerRows.length})` : ''}
            </Tab>
            <Tab className={SUB_TAB} id='auth'>
              Auth
            </Tab>
            <Tab className={SUB_TAB} id='docs'>
              Docs
            </Tab>
          </TabList>

          <TabPanel className={`${SUB_PANEL} p-3`} id='params'>
            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between gap-2'>
                <SectionTitle>Top-level args</SectionTitle>
                <Button
                  className='text-muted data-hovered:text-accent text-[11.5px] underline-offset-2 data-hovered:underline'
                  onPress={() => setReqTab('body')}>
                  edit raw JSON →
                </Button>
              </div>

              {parsed.ok ? null : (
                <p className='text-danger text-[12px]'>
                  Args JSON is invalid — fix it in Body first: {parsed.error}
                </p>
              )}

              {fields.length === 0 ? (
                <p className='text-muted text-[12.5px]'>This function takes no arguments.</p>
              ) : (
                <div className='flex flex-col gap-1'>
                  {fields.map(field => (
                    <div key={field.name} className='flex items-center gap-2'>
                      <span
                        className='text-ink w-40 shrink-0 truncate font-mono text-[12px]'
                        title={field.name}>
                        {field.inPath ? <span className='text-accent'>:</span> : null}
                        {field.name}
                        {field.required ? <span className='text-danger'>*</span> : null}
                      </span>
                      <span
                        className='text-muted w-24 shrink-0 truncate font-mono text-[11px]'
                        title={field.type}>
                        {field.type}
                      </span>
                      <TextField
                        aria-label={`Value for ${field.name}`}
                        className='min-w-0 flex-1'
                        isDisabled={!parsed.ok}
                        onChange={text => updateArg(field.name, text, field.type)}
                        value={argText(parsedArgs?.[field.name])}>
                        <Label className='sr-only'>{field.name}</Label>
                        <Input className={FIELD_INPUT} placeholder='—' />
                      </TextField>
                    </div>
                  ))}
                </div>
              )}

              <p className='text-muted text-[11.5px]'>
                Path <span className='text-accent font-mono'>:params</span> fill from args; leftover
                args go to the query string on GET and to the JSON body otherwise. Values parse as
                JSON when possible; schema-typed strings stay raw.
              </p>
            </div>
          </TabPanel>

          <TabPanel className={`${SUB_PANEL} flex flex-col`} id='body'>
            <div className='border-line flex shrink-0 items-center gap-2 border-b px-3 py-1.5'>
              <span className={`text-[11.5px] ${parsed.ok ? 'text-muted' : 'text-danger'}`}>
                {parsed.ok
                  ? parsed.wrapped
                    ? 'valid — non-object wrapped as { body }'
                    : 'valid JSON'
                  : parsed.error}
              </span>
              <span className='flex-1' />
              <Button
                className='border-line text-muted data-hovered:text-ink rounded border px-2 py-0.5 text-[11.5px]'
                isDisabled={!parsed.ok}
                onPress={() => {
                  try {
                    setArgsText(
                      JSON.stringify(JSON.parse(argsText.trim() === '' ? '{}' : argsText), null, 2),
                    )
                  } catch {
                    // keep the text as typed — the validity hint already explains
                  }
                }}>
                Prettify
              </Button>
              <Button
                className='border-line text-muted data-hovered:text-ink rounded border px-2 py-0.5 text-[11.5px]'
                onPress={() => setArgsText(JSON.stringify(skeletonOf(entry.args), null, 2))}>
                Reset to skeleton
              </Button>
            </div>
            <TextField
              aria-label='Arguments as JSON'
              className='flex min-h-0 flex-1 flex-col'
              onChange={setArgsText}
              value={argsText}>
              <Label className='sr-only'>Arguments as JSON</Label>
              <TextArea
                className='text-ink min-h-0 w-full flex-1 resize-none bg-transparent p-3 font-mono text-[12.5px] leading-5 outline-none'
                onKeyDown={event => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && parsed.ok) {
                    void send(argsText)
                  }
                }}
                spellCheck={false}
              />
            </TextField>
          </TabPanel>

          <TabPanel className={`${SUB_PANEL} p-3`} id='files'>
            <div className='flex flex-col gap-2'>
              <p className='text-muted text-[12px]'>
                {entry.channels.input.includes('parts')
                  ? 'This function accepts multipart file parts.'
                  : 'Any attachment switches the request to multipart/form-data (fields first, then files).'}
              </p>
              <FileAttach files={files} onChange={setFiles} />
            </div>
          </TabPanel>

          <TabPanel className={`${SUB_PANEL} p-3`} id='headers'>
            <div className='flex flex-col gap-2'>
              <p className='text-muted text-[12px]'>
                Extra request headers — sent on top of auth and content-type (same-name overrides).
              </p>
              <KvEditor
                addLabel='Add header'
                keyPlaceholder='x-header-name'
                onChange={setHeaderRows}
                rows={headerRows}
              />
            </div>
          </TabPanel>

          <TabPanel className={`${SUB_PANEL} p-3`} id='auth'>
            <div className='flex max-w-md flex-col gap-3'>
              <div className='flex items-center gap-2'>
                <SectionTitle>Bearer token</SectionTitle>
                {globalToken === '' ? (
                  <StatePill label='no global token' tone='muted' />
                ) : (
                  <StatePill label={`global ••••${globalToken.slice(-4)}`} tone='ok' />
                )}
              </div>
              <TextField
                className='flex flex-col gap-1'
                onChange={setAuthOverride}
                value={authOverride}>
                <Label className='text-muted text-[12px] font-medium'>Override for this tab</Label>
                <Input className={FIELD_INPUT} placeholder='leave empty to use the global token' />
              </TextField>
              <Button
                className='text-muted data-hovered:text-accent self-start text-[12px] underline-offset-2 data-hovered:underline'
                onPress={onOpenSettings}>
                Edit the global token in Settings →
              </Button>
            </div>
          </TabPanel>

          <TabPanel className={SUB_PANEL} id='docs'>
            {docsPanel}
          </TabPanel>
        </Tabs>

        <div className='flex h-full min-h-0 flex-col'>
          <div className='border-line flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b px-2.5'>
            {run === null ? (
              <span className='text-muted text-[11px] font-semibold tracking-widest uppercase'>
                Response
              </span>
            ) : (
              <>
                {run.phase === 'running' ? (
                  <StatePill label='sending' pulse tone='accent' />
                ) : run.status === null ? (
                  <StatePill
                    label={run.phase === 'aborted' ? 'cancelled' : 'failed'}
                    tone={run.phase === 'aborted' ? 'muted' : 'err'}
                  />
                ) : (
                  <StatePill
                    label={`${run.status} ${run.statusText}`.trim()}
                    tone={statusTone(run.status)}
                  />
                )}
                {run.phase === 'streaming' ? (
                  <StatePill label='streaming' pulse tone='accent' />
                ) : null}
                {run.phase === 'aborted' && run.status !== null ? (
                  <StatePill label='cancelled' tone='muted' />
                ) : null}
                {run.kind === null ? null : <Pill>{run.kind}</Pill>}
                {run.headerMs === null ? null : (
                  <span className='text-muted text-[11.5px] whitespace-nowrap'>
                    {run.headerMs}ms{run.totalMs === null ? '' : ` / ${run.totalMs}ms`}
                  </span>
                )}
                {run.size === null ? null : (
                  <span className='text-muted text-[11.5px] whitespace-nowrap'>
                    {formatBytes(run.size)}
                  </span>
                )}
                {run.requestId === null ? null : (
                  <span className='text-muted flex items-center gap-0.5 text-[11.5px] whitespace-nowrap'>
                    <span className='text-ink max-w-40 truncate font-mono'>{run.requestId}</span>
                    <CopyButton label='Copy x-request-id' text={run.requestId} />
                  </span>
                )}
              </>
            )}
            <span className='flex-1' />
            {history.length === 0 ? null : (
              <DialogTrigger>
                <Button
                  aria-label='Run history'
                  className='text-muted data-hovered:text-ink flex items-center gap-1 rounded p-1'>
                  <ClockIcon />
                  <span className='text-[11px]'>{history.length}</span>
                </Button>
                <Popover
                  className='border-line bg-panel max-h-80 w-96 overflow-y-auto rounded border shadow-xl'
                  placement='bottom end'>
                  <Dialog aria-label='Run history' className='p-1 outline-none'>
                    {({ close }) =>
                      history.map(record => (
                        <Button
                          key={record.id}
                          className='data-hovered:bg-card flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]'
                          onPress={() => {
                            close()
                            rerun(record)
                          }}>
                          <span className='text-muted shrink-0 font-mono'>
                            {new Date(record.at).toISOString().slice(11, 19)}
                          </span>
                          <span
                            className={`shrink-0 font-mono font-bold ${record.ok ? 'text-ok' : 'text-danger'}`}>
                            {record.status ?? '—'}
                          </span>
                          <span className='text-muted shrink-0'>
                            {record.ms === null ? '' : `${record.ms}ms`}
                          </span>
                          <span className='text-muted min-w-0 flex-1 truncate font-mono'>
                            {record.argsText.replaceAll(/\s+/gu, ' ')}
                          </span>
                          {record.fileCount > 0 ? (
                            <span className='text-muted shrink-0'>{record.fileCount}f</span>
                          ) : null}
                        </Button>
                      ))
                    }
                  </Dialog>
                </Popover>
              </DialogTrigger>
            )}
          </div>

          {run === null ? (
            <div className='flex min-h-0 flex-1 items-center justify-center'>
              <span className='text-muted text-[13px] opacity-70'>Send a request</span>
            </div>
          ) : (
            <Tabs className='flex min-h-0 flex-1 flex-col' defaultSelectedKey='body'>
              <TabList aria-label='Response sections' className={SUB_TAB_LIST}>
                <Tab className={SUB_TAB} id='body'>
                  Body
                </Tab>
                <Tab className={SUB_TAB} id='headers'>
                  Headers{run.headers.length > 0 ? ` (${run.headers.length})` : ''}
                </Tab>
                <Tab className={SUB_TAB} id='timeline'>
                  Timeline
                </Tab>
              </TabList>

              <TabPanel className={`${SUB_PANEL} flex flex-col`} id='body'>
                {run.failure === null ? null : (
                  <p className='text-danger shrink-0 px-3 pt-2 text-[12.5px]'>{run.failure}</p>
                )}

                {run.kind === 'json' && run.text !== null ? (
                  <>
                    <div className='border-line flex shrink-0 items-center gap-1 border-b px-3 py-1'>
                      <Button
                        className={`rounded px-2 py-0.5 text-[11.5px] ${bodyView === 'pretty' ? 'bg-card text-ink' : 'text-muted data-hovered:text-ink'}`}
                        onPress={() => setBodyView('pretty')}>
                        Pretty
                      </Button>
                      <Button
                        className={`rounded px-2 py-0.5 text-[11.5px] ${bodyView === 'raw' ? 'bg-card text-ink' : 'text-muted data-hovered:text-ink'}`}
                        onPress={() => setBodyView('raw')}>
                        Raw
                      </Button>
                      <span className='flex-1' />
                      <CopyButton label='Copy response body' text={run.text} />
                    </div>
                    <div className='min-h-0 flex-1 overflow-auto p-3'>
                      {bodyView === 'raw' || parsedBody === undefined ? (
                        <pre className='font-mono text-[12.5px] leading-5 whitespace-pre-wrap'>
                          <code>{run.text}</code>
                        </pre>
                      ) : (
                        <JsonTree value={parsedBody} />
                      )}
                    </div>
                  </>
                ) : null}

                {run.kind === 'text' && run.text !== null ? (
                  <pre className='min-h-0 flex-1 overflow-auto p-3 font-mono text-[12.5px] leading-5 whitespace-pre-wrap'>
                    {run.text}
                  </pre>
                ) : null}

                {streamedRun ? (
                  <div className='min-h-0 flex-1 overflow-auto p-2 font-mono text-[12px] leading-5'>
                    {dataLines.length === 0 ? (
                      <div className='text-muted p-2'>
                        {run.phase === 'done'
                          ? 'Stream ended without events'
                          : 'Waiting for events…'}
                      </div>
                    ) : (
                      dataLines.map((line, index) => (
                        // oxlint-disable-next-line react/no-array-index-key -- append-only stream
                        <div key={index} className='text-ink break-all whitespace-pre-wrap'>
                          {line.text}
                        </div>
                      ))
                    )}
                  </div>
                ) : null}

                {run.bytes === null ? null : (
                  <div className='flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-3'>
                    <span className='text-muted text-[12px]'>
                      binary body · {formatBytes(run.bytes.size)}
                    </span>
                    <pre className='font-mono text-[12px] leading-5'>{run.bytes.hex}</pre>
                  </div>
                )}

                {run.phase === 'running' ? (
                  <div className='text-muted flex min-h-0 flex-1 items-center justify-center text-[12.5px]'>
                    sending…
                  </div>
                ) : null}
              </TabPanel>

              <TabPanel className={`${SUB_PANEL} p-3`} id='headers'>
                {run.headers.length === 0 ? (
                  <p className='text-muted text-[12.5px]'>No headers yet</p>
                ) : (
                  <table className='w-full border-collapse text-[12px]'>
                    <tbody>
                      {run.headers.map(([name, value]) => (
                        <tr key={name}>
                          <td className='border-line text-muted w-52 border-b px-2 py-0.5 align-top font-mono'>
                            {name}
                          </td>
                          <td className='border-line text-ink border-b px-2 py-0.5 font-mono break-all'>
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </TabPanel>

              <TabPanel className={SUB_PANEL} id='timeline'>
                <Timeline empty='Request events appear here' entries={run.lines} />
              </TabPanel>
            </Tabs>
          )}
        </div>
      </SplitLayout>
    </div>
  )
}
