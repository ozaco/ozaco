/**
 * File-list state helpers for the multipart try-it flow — a plain immutable list the UI folds
 * over. Every operation returns a NEW array; `field` is the multipart field name the file is
 * appended under (`buildRequest` appends fields first, then files, preserving list order).
 */

let counter = 0

const nextId = (): string => {
  counter += 1

  return `f${counter}`
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export interface UploadFile {
  readonly id: string
  /** Multipart field name (defaults to `file`). */
  readonly field: string
  readonly file: File
}

export const addFiles = (
  list: readonly UploadFile[],
  files: Iterable<File>,
  field = 'file',
): UploadFile[] => [...list, ...[...files].map(file => ({ id: nextId(), field, file }))]

export const removeFile = (list: readonly UploadFile[], id: string): UploadFile[] =>
  list.filter(entry => entry.id !== id)

/** Move an entry one slot up (`-1`) or down (`1`); out-of-range moves are no-ops. */
export const moveFile = (
  list: readonly UploadFile[],
  id: string,
  direction: -1 | 1,
): UploadFile[] => {
  const index = list.findIndex(entry => entry.id === id)
  const target = index + direction

  if (index === -1 || target < 0 || target >= list.length) {
    return [...list]
  }

  const next = [...list]
  const moved = next[index] as UploadFile

  next[index] = next[target] as UploadFile
  next[target] = moved

  return next
}

export const renameField = (list: readonly UploadFile[], id: string, field: string): UploadFile[] =>
  list.map(entry => (entry.id === id ? { ...entry, field } : entry))

export const totalSize = (list: readonly UploadFile[]): number =>
  list.reduce((sum, entry) => sum + entry.file.size, 0)

/** `1536` → `'1.5 KB'`; whole numbers drop the decimal (`'12 B'`, `'2 MB'`). */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B'
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  const rounded = Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)

  return `${text} ${UNITS[unit]}`
}
