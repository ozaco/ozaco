/**
 * Fetch-based SSE reader — `EventSource` cannot send `Authorization`, so the panel reads
 * `text/event-stream` bodies by hand. The edge's contract: a `: ok` comment opener, then each
 * frame as one `data: <json>` line followed by a blank line. The parser is incremental and
 * tolerates ANY chunk boundary (mid-line, mid-`data:` token, split CRLF).
 */

export interface SseParserHandlers {
  /** One dispatched event (joined `data:` payload). */
  readonly onData: (data: string) => void
  /** `:`-prefixed comment lines (the edge's `: ok` opener keeps proxies happy). */
  readonly onComment?: (comment: string) => void
}

export interface SseParser {
  /** Feed one byte chunk (any boundary). */
  readonly push: (chunk: Uint8Array) => void
  /** Flush the tail once the stream ends. */
  readonly end: () => void
}

export const createSseParser = (handlers: SseParserHandlers): SseParser => {
  const decoder = new TextDecoder()
  let buffered = ''
  let dataLines: string[] = []
  let sawData = false

  const dispatch = (): void => {
    if (sawData) {
      handlers.onData(dataLines.join('\n'))
    }

    dataLines = []
    sawData = false
  }

  const consumeLine = (line: string): void => {
    if (line === '') {
      dispatch()

      return
    }

    if (line.startsWith(':')) {
      handlers.onComment?.(line.slice(1).replace(/^ /u, ''))

      return
    }

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')

    if (field === 'data') {
      sawData = true
      dataLines.push(value)
    }
    // other fields (event/id/retry) are irrelevant to the edge contract — ignored
  }

  const consume = (text: string): void => {
    buffered += text

    for (;;) {
      const newline = buffered.indexOf('\n')

      if (newline === -1) {
        return
      }

      const rawLine = buffered.slice(0, newline)

      buffered = buffered.slice(newline + 1)
      consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
    }
  }

  return {
    push: chunk => {
      consume(decoder.decode(chunk, { stream: true }))
    },
    end: () => {
      consume(decoder.decode())

      if (buffered !== '') {
        consumeLine(buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered)
        buffered = ''
      }

      dispatch()
    },
  }
}

export interface SseConnectInput {
  readonly url: string
  readonly token?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Each `data:` payload, JSON-parsed. */
  readonly onJson: (value: unknown) => void
  /** Payloads that are not valid JSON (raw text). */
  readonly onRaw?: (data: string) => void
  readonly onComment?: (comment: string) => void
  readonly onError?: (error: unknown) => void
  /** The stream ended (server closed or `stop()`). */
  readonly onEnd?: () => void
}

export interface SseConnection {
  /** Settles when the stream is fully drained or aborted (never rejects). */
  readonly done: Promise<void>
  readonly stop: () => void
}

/** Open an SSE stream via fetch and pump it through {@link createSseParser}. */
export const connectSse = (input: SseConnectInput): SseConnection => {
  const controller = new AbortController()

  const parser = createSseParser({
    onData: data => {
      try {
        input.onJson(JSON.parse(data))
      } catch {
        input.onRaw?.(data)
      }
    },
    ...(input.onComment === undefined ? {} : { onComment: input.onComment }),
  })

  const pump = async (): Promise<void> => {
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      ...input.headers,
    }

    if (input.token !== undefined && input.token !== '') {
      headers['authorization'] = `Bearer ${input.token}`
    }

    const response = await fetch(input.url, { headers, signal: controller.signal })

    if (!response.ok || response.body === null) {
      throw new Error(`sse request failed: ${response.status} ${response.statusText}`)
    }

    const reader = response.body.getReader()

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream chunks are inherently sequential
      const step = await reader.read()

      if (step.done) {
        parser.end()

        return
      }

      parser.push(step.value)
    }
  }

  const done = pump()
    .catch((error: unknown) => {
      if (!controller.signal.aborted) {
        input.onError?.(error)
      }
    })
    .finally(() => {
      input.onEnd?.()
    })

  return {
    done,
    stop: () => {
      controller.abort()
    },
  }
}
