export const parseWsPayload = (payload: unknown): unknown => {
  if (payload === null || payload === undefined) {
    return null
  }
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(payload)
      } catch {
        return payload
      }
    }
    return payload
  }
  return payload
}

export const encodeWsBody = (body: unknown): string | ArrayBufferView | ArrayBuffer | null => {
  if (body === undefined || body === null) {
    return null
  }
  if (typeof body === 'string') {
    return body
  }
  if (body instanceof ArrayBuffer) {
    return body
  }
  if (ArrayBuffer.isView(body)) {
    return body as ArrayBufferView
  }
  return JSON.stringify(body)
}
