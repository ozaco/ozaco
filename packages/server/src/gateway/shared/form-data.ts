import type { ActionFile, GatewayDef, MultipartPart } from 'server:core'
import { operation } from 'std:effect'
import { IO } from 'std:io'

export const matchFileKey = (matcher: GatewayDef.RestOptions['files'], key: string): boolean => {
  if (!matcher) {
    return false
  }
  if (Array.isArray(matcher)) {
    return matcher.includes(key)
  }
  if (matcher instanceof RegExp) {
    return matcher.test(key)
  }
  return matcher(key)
}

export const appendField = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key in target) {
    const prev = target[key]
    target[key] = Array.isArray(prev) ? [...prev, value] : [prev, value]
  } else {
    target[key] = value
  }
}

export const appendFile = (
  target: Record<string, ActionFile[]>,
  key: string,
  file: ActionFile,
): void => {
  if (!target[key]) {
    target[key] = []
  }
  target[key].push(file)
}

export const stringToFile = (key: string, value: string): ActionFile => {
  const blob = new Blob([value])
  return {
    name: key,
    type: 'text/plain',
    size: blob.size,
    stream: IO.actions.fromReadable(blob.stream().getReader()),
  }
}

// A (buffered) mode: spill each uploaded file to a temp file so the whole files map can be handed to
// the action while memory stays bounded (one file's chunk at a time streams to disk, never the whole
// file in RAM). The spilled files are removed at request-scope teardown by the caller.

/** Create a fresh per-request spill directory under the OS temp dir. */
export const spillDir = operation(function* () {
  const base = yield* IO.actions.tmpdir()
  const id = yield* IO.actions.uuid()
  const dir = yield* IO.actions.join(base, `ozaco-upload-${id}`)
  yield* IO.actions.ensureDir(dir)
  return dir
})

/** Stream one file part to a temp file (bounded memory) and return an `ActionFile` that reads it back
 * lazily, plus the temp path so the caller can clean it up when the request ends. */
export const spillFile = operation(function* (
  dir: string,
  part: Extract<MultipartPart, { kind: 'file' }>,
) {
  const id = yield* IO.actions.uuid()
  const path = yield* IO.actions.join(dir, id)
  yield* IO.actions.writeStream(path, part.stream)
  const info = yield* IO.actions.stat(path)
  const file: ActionFile = {
    name: part.filename ?? part.name,
    type: part.mediaType ?? 'application/octet-stream',
    size: info.size,
    stream: IO.actions.readStream(path),
  }
  return { file, path }
})
