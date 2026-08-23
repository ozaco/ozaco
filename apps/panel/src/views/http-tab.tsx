/**
 * One HTTP request tab: URL bar (method + path with params + Send/Cancel), request sub-tabs
 * (Params / Body / Files / Headers / Auth / Docs) over ONE input source of truth (the body JSON),
 * and the response pane (status · elapsed · size · request id; Body pretty|raw, Headers,
 * Timeline) that fills live while a stream is open.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { MethodTag, StatusPill } from '../components/badges'
import { JsonTree } from '../components/json-tree'
import type { Pair } from '../components/kv-editor'
import { KvEditor, pairsToRecord } from '../components/kv-editor'
import { SplitLayout } from '../components/split'
import type { Line } from '../components/timeline'
import { Timeline } from '../components/timeline'
import type { Connection } from '../lib/config'
import { KEYS } from '../lib/config'
import type { Action } from '../lib/manifest'
import { pathParams } from '../lib/manifest'
import type { Chunk, InFlight, Outcome } from '../lib/ozaco'
import { send } from '../lib/ozaco'
import { coerceField, exampleOf, fieldsOf } from '../lib/schema'

interface Props {
  readonly action: Action
  readonly connection: Connection
  readonly onToken: (token: string) => void
}

type ReqTab = 'params' | 'body' | 'files' | 'headers' | 'auth' | 'docs'
type ResTab = 'pretty' | 'raw' | 'headers' | 'timeline'

const SubTabs = <T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly (readonly [T, string])[]
  value: T
  onChange: (next: T) => void
}) => (
  <div className='subtabs'>
    {tabs.map(([id, label]) => (
      <div
        key={id}
        className='subtab'
        data-selected={id === value || undefined}
        onClick={() => onChange(id)}>
        {label}
      </div>
    ))}
  </div>
)

const fmtBytes = (size: number): string =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(2)} MB`

export const HttpTab = ({ action, connection, onToken }: Props) => {
  const isValue = action.input.plane === 'value'
  const isParts = action.input.plane === 'parts'
  const isStream = action.input.plane === 'stream'
  const params = useMemo(() => pathParams(action.route.path), [action.route.path])
  const fields = useMemo(() => fieldsOf(action.input.schema), [action.input.schema])

  const [bodyText, setBodyText] = useState(() => {
    const example = exampleOf(action.input.schema)
    return action.input.plane === 'none' ? '' : JSON.stringify(example ?? {}, null, 2)
  })
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [rawFile, setRawFile] = useState<File | null>(null)
  const [headers, setHeaders] = useState<Pair[]>([])
  const [authOverride, setAuthOverride] = useState('')
  const [reqTab, setReqTab] = useState<ReqTab>(
    isParts ? 'files' : isStream ? 'files' : action.route.method === 'GET' ? 'params' : 'body',
  )
  const [resTab, setResTab] = useState<ResTab>('pretty')

  const [inFlight, setInFlight] = useState<InFlight | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [history, setHistory] = useState<
    { at: number; status: number | null; ok: boolean; elapsedMs: number }[]
  >([])
  const startedAt = useRef(0)

  // the Params form is a projection over the body JSON
  const body = useMemo(() => {
    try {
      return bodyText.trim() ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
    } catch {
      return null
    }
  }, [bodyText])
  const setField = (name: string, value: unknown) => {
    const next = new Map(Object.entries(body ?? {}))
    if (value === undefined) {
      next.delete(name)
    } else {
      next.set(name, value)
    }
    setBodyText(JSON.stringify(Object.fromEntries(next), null, 2))
  }

  const resolvedPath = action.route.path.replaceAll(/:([A-Za-z_]\w*)/gu, (_match, name: string) => {
    const value = body?.[name]
    return value === undefined || value === '' ? `:${name}` : encodeURIComponent(String(value))
  })

  const run = async () => {
    if (inFlight) {
      await inFlight.cancel()
      setInFlight(null)
      setLines(prior => [
        ...prior,
        { at: performance.now() - startedAt.current, tone: 'error', text: 'cancelled' },
      ])
      return
    }
    if (body === null && (isValue || isParts)) {
      setLines([{ at: 0, tone: 'error', text: 'body is not valid JSON' }])
      return
    }
    let input: unknown = body
    if (isParts) {
      input = {
        fields: body,
        streams: Object.fromEntries(
          Object.entries(files)
            .filter(([, file]) => file)
            .map(([name, file]) => [name, file!]),
        ),
      }
    } else if (isStream) {
      input = rawFile ?? new Uint8Array()
    } else if (action.input.plane === 'none') {
      input = undefined
    }
    const extraHeaders = pairsToRecord(headers)
    if (authOverride.trim()) {
      extraHeaders['authorization'] = authOverride.trim().startsWith('Bearer ')
        ? authOverride.trim()
        : `Bearer ${authOverride.trim()}`
    }
    setChunks([])
    setOutcome(null)
    startedAt.current = performance.now()
    setLines([{ at: 0, tone: 'out', text: `${action.route.method} ${resolvedPath}` }])
    const flight = send(
      { connection, service: action.service, action: action.action, input, headers: extraHeaders },
      chunk => {
        setChunks(prior => [...prior, chunk])
        setLines(prior => [
          ...prior,
          {
            at: chunk.at,
            tone: 'in',
            text:
              chunk.kind === 'value'
                ? JSON.stringify(chunk.value)
                : chunk.kind === 'text'
                  ? chunk.text
                  : `${fmtBytes(chunk.size)} so far`,
          },
        ])
      },
    )
    setInFlight(flight)
    const result = await flight.done
    setInFlight(null)
    setOutcome(result)
    setHistory(prior =>
      [
        { at: Date.now(), status: result.status, ok: result.ok, elapsedMs: result.elapsedMs },
        ...prior,
      ].slice(0, 20),
    )
    setLines(prior => [
      ...prior,
      {
        at: result.elapsedMs,
        tone: result.ok ? 'info' : 'error',
        text: result.ok
          ? `${result.status} · ${result.brand ?? 'json'} · ${result.elapsedMs}ms · ${result.requestId ?? ''}`
          : `${result.error?.tag}: ${result.error?.message}`,
      },
    ])
  }

  useEffect(() => () => void inFlight?.cancel(), [inFlight])

  const size = outcome?.bytes
    ? outcome.bytes.length
    : outcome
      ? new TextEncoder().encode(JSON.stringify(outcome.value ?? outcome.error) ?? '').length
      : 0
  const tokenInAnswer =
    outcome?.ok &&
    outcome.value &&
    typeof outcome.value === 'object' &&
    'accessToken' in (outcome.value as object)
      ? String((outcome.value as { accessToken: unknown }).accessToken)
      : null

  const request = (
    <div className='flex h-full flex-col'>
      <div
        className='flex items-center gap-2 border-b px-3 py-2'
        style={{ borderColor: 'var(--line)' }}>
        <MethodTag method={action.route.method} wide />
        <div
          className='mono flex-1 truncate rounded px-2 py-1'
          style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          {resolvedPath.split(/(:\w+)/u).map((part, index) =>
            part.startsWith(':') ? (
              <span key={index} style={{ color: 'var(--warn)' }}>
                {part}
              </span>
            ) : (
              <span key={index}>{part}</span>
            ),
          )}
        </div>
        <button className={`btn ${inFlight ? 'btn-bad' : 'btn-accent'}`} onClick={run}>
          {inFlight ? 'Cancel' : 'Send'}
        </button>
      </div>
      <SubTabs<ReqTab>
        tabs={[
          ['params', 'Params'],
          ['body', 'Body'],
          ['files', 'Files'],
          ['headers', 'Headers'],
          ['auth', 'Auth'],
          ['docs', 'Docs'],
        ]}
        value={reqTab}
        onChange={setReqTab}
      />
      <div className='min-h-0 flex-1 overflow-auto'>
        {reqTab === 'params' && (
          <div className='flex flex-col gap-1 p-2'>
            {params.map(name => (
              <label key={name} className='flex items-center gap-2'>
                <span className='mono w-[140px] truncate' style={{ color: 'var(--warn)' }}>
                  :{name}
                </span>
                <input
                  className='input'
                  value={String(body?.[name] ?? '')}
                  onChange={event => setField(name, event.target.value || undefined)}
                />
              </label>
            ))}
            {fields
              .filter(field => !params.includes(field.name))
              .map(field => (
                <label
                  key={field.name}
                  className='flex items-center gap-2'
                  title={field.description}>
                  <span className='mono w-[140px] truncate'>
                    {field.name}
                    {field.required && <span style={{ color: 'var(--bad)' }}>*</span>}
                  </span>
                  {field.options ? (
                    <select
                      className='input'
                      value={String(body?.[field.name] ?? '')}
                      onChange={event => setField(field.name, event.target.value || undefined)}>
                      <option value=''>—</option>
                      {field.options.map(option => (
                        <option key={String(option)} value={String(option)}>
                          {String(option)}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'boolean' ? (
                    <select
                      className='input'
                      value={body?.[field.name] === undefined ? '' : String(body[field.name])}
                      onChange={event =>
                        setField(
                          field.name,
                          event.target.value === '' ? undefined : event.target.value === 'true',
                        )
                      }>
                      <option value=''>—</option>
                      <option value='true'>true</option>
                      <option value='false'>false</option>
                    </select>
                  ) : (
                    <input
                      className='input mono'
                      placeholder={field.type}
                      value={
                        body?.[field.name] === undefined
                          ? ''
                          : typeof body[field.name] === 'string'
                            ? String(body[field.name])
                            : JSON.stringify(body[field.name])
                      }
                      onChange={event =>
                        setField(field.name, coerceField(event.target.value, field.type))
                      }
                    />
                  )}
                </label>
              ))}
            {fields.length === 0 && params.length === 0 && (
              <div style={{ color: 'var(--dim)' }}>no parameters</div>
            )}
          </div>
        )}
        {reqTab === 'body' && (
          <div className='flex h-full flex-col gap-1 p-2'>
            <div className='flex gap-1'>
              <button
                className='btn'
                onClick={() => body && setBodyText(JSON.stringify(body, null, 2))}>
                prettify
              </button>
              <button
                className='btn'
                onClick={() =>
                  setBodyText(JSON.stringify(exampleOf(action.input.schema) ?? {}, null, 2))
                }>
                reset
              </button>
              {body === null && <span style={{ color: 'var(--bad)' }}>invalid JSON</span>}
            </div>
            <textarea
              className='input min-h-0 flex-1'
              rows={14}
              value={bodyText}
              onChange={event => setBodyText(event.target.value)}
              onKeyDown={event => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  void run()
                }
              }}
            />
          </div>
        )}
        {reqTab === 'files' && (
          <div className='flex flex-col gap-2 p-2'>
            {isParts &&
              Object.entries(action.input.streams ?? {}).map(([name, brand]) => (
                <label key={name} className='flex items-center gap-2'>
                  <span className='mono w-[140px]'>{name}</span>
                  <input
                    type='file'
                    onChange={event =>
                      setFiles({ ...files, [name]: event.target.files?.[0] ?? null })
                    }
                  />
                  <span style={{ color: 'var(--dim)' }}>{brand}</span>
                </label>
              ))}
            {isStream && (
              <label className='flex items-center gap-2'>
                <span className='mono w-[140px]'>body</span>
                <input
                  type='file'
                  onChange={event => setRawFile(event.target.files?.[0] ?? null)}
                />
                <span style={{ color: 'var(--dim)' }}>{action.input.contentType}</span>
              </label>
            )}
            {!isParts && !isStream && (
              <div style={{ color: 'var(--dim)' }}>this action takes no file</div>
            )}
          </div>
        )}
        {reqTab === 'headers' && <KvEditor pairs={headers} onChange={setHeaders} />}
        {reqTab === 'auth' && (
          <div className='flex flex-col gap-2 p-2'>
            <div style={{ color: 'var(--dim)' }}>
              {connection.token
                ? 'the connection token is sent as a bearer'
                : 'no connection token (settings)'}
              ; override for this request:
            </div>
            <input
              className='input mono'
              placeholder='Bearer …'
              value={authOverride}
              onChange={event => setAuthOverride(event.target.value)}
            />
            <div style={{ color: 'var(--dim)' }}>
              requires: {JSON.stringify(action.options['auth'] ?? 'nothing')}
            </div>
          </div>
        )}
        {reqTab === 'docs' && (
          <div className='flex flex-col gap-2 p-2'>
            {action.title && <b>{action.title}</b>}
            {action.description && <div>{action.description}</div>}
            <div style={{ color: 'var(--dim)' }}>
              {action.kind} · {action.route.method} {action.route.path} · in: {action.input.plane}
              {action.input.brand ? ` (${action.input.brand})` : ''} · out: {action.output.plane}
              {action.output.brand ? ` (${action.output.brand})` : ''}
            </div>
            <div className='font-semibold'>input</div>
            <JsonTree value={action.input.schema ?? null} />
            <div className='font-semibold'>output</div>
            <JsonTree value={action.output.schema ?? null} />
            {Object.keys(action.options).length > 0 && (
              <>
                <div className='font-semibold'>options</div>
                <JsonTree value={action.options} />
              </>
            )}
            {Object.keys(action.errors).length > 0 && (
              <>
                <div className='font-semibold'>errors</div>
                <JsonTree value={action.errors} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )

  const answer = outcome?.ok ? outcome.value : outcome?.error
  const response = (
    <div className='flex h-full flex-col'>
      <div
        className='flex h-[41px] items-center gap-2 border-b px-3'
        style={{ borderColor: 'var(--line)' }}>
        {outcome ? (
          <>
            <StatusPill status={outcome.status} ok={outcome.ok} />
            <span style={{ color: 'var(--dim)' }}>{outcome.elapsedMs} ms</span>
            <span style={{ color: 'var(--dim)' }}>{fmtBytes(size)}</span>
            {outcome.brand && (
              <span className='pill' style={{ background: 'var(--panel-2)', color: 'var(--dim)' }}>
                {outcome.brand}
              </span>
            )}
            <span
              className='mono ml-auto truncate'
              style={{ color: 'var(--dim)' }}
              title='x-request-id'>
              {outcome.requestId}
            </span>
          </>
        ) : inFlight ? (
          <span style={{ color: 'var(--dim)' }}>
            sending…{chunks.length > 0 ? ` ${chunks.length} chunk(s)` : ''}
          </span>
        ) : (
          <span style={{ color: 'var(--dim)' }}>no response yet</span>
        )}
        {history.length > 1 && (
          <select className='input ml-2 w-auto' onChange={() => {}} title='history'>
            {history.map(entry => (
              <option
                key={
                  entry.at
                }>{`${new Date(entry.at).toLocaleTimeString()} ${entry.status ?? (entry.ok ? 'ok' : 'err')} ${entry.elapsedMs}ms`}</option>
            ))}
          </select>
        )}
      </div>
      <SubTabs<ResTab>
        tabs={[
          ['pretty', 'Pretty'],
          ['raw', 'Raw'],
          ['headers', 'Headers'],
          ['timeline', 'Timeline'],
        ]}
        value={resTab}
        onChange={setResTab}
      />
      <div className='min-h-0 flex-1 overflow-auto p-2'>
        {resTab === 'pretty' && (
          <>
            {tokenInAnswer && (
              <button className='btn btn-accent mb-2' onClick={() => onToken(tokenInAnswer)}>
                use accessToken as the connection token
              </button>
            )}
            {outcome?.bytes ? (
              <div>
                <div>{fmtBytes(outcome.bytes.length)} of bytes</div>
                <a
                  className='btn mt-2'
                  href={URL.createObjectURL(new Blob([outcome.bytes as BlobPart]))}
                  download={`${action.action}.bin`}>
                  download
                </a>
              </div>
            ) : inFlight && chunks.length > 0 ? (
              <JsonTree
                value={chunks.map(chunk =>
                  chunk.kind === 'value'
                    ? chunk.value
                    : chunk.kind === 'text'
                      ? chunk.text
                      : chunk.size,
                )}
              />
            ) : outcome ? (
              <JsonTree value={answer} />
            ) : null}
          </>
        )}
        {resTab === 'raw' && (
          <pre className='mono break-all whitespace-pre-wrap'>
            {outcome?.bytes
              ? `${outcome.bytes.length} bytes`
              : outcome
                ? typeof answer === 'string'
                  ? answer
                  : JSON.stringify(answer, null, 2)
                : ''}
          </pre>
        )}
        {resTab === 'headers' && (
          <JsonTree
            value={
              outcome
                ? {
                    status: outcome.status,
                    'x-request-id': outcome.requestId,
                    'oz-brand': outcome.brand,
                    'oz-error': outcome.error?.tag ?? null,
                  }
                : {}
            }
          />
        )}
        {resTab === 'timeline' && <Timeline lines={lines} />}
      </div>
    </div>
  )

  return <SplitLayout left={request} right={response} storageKey={KEYS.split} />
}
