import { IO } from 'std:io'

import type { ActionFile } from 'server:service'

import type { RestTransformerOptions } from '../types/transformer'

export const matchFileKey = (matcher: RestTransformerOptions['files'], key: string): boolean => {
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

export const blobToFile = (blob: Blob, fallbackName: string): ActionFile => {
  const maybeFile = blob as Blob & { name?: string; lastModified?: number }
  return {
    name: typeof maybeFile.name === 'string' ? maybeFile.name : fallbackName,
    type: blob.type || 'application/octet-stream',
    size: blob.size,
    lastModified: typeof maybeFile.lastModified === 'number' ? maybeFile.lastModified : undefined,
    stream: IO.actions.fromReadable(blob.stream().getReader()),
  }
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
