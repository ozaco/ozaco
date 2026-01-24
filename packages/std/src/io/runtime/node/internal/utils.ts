import fs from 'node:fs'

import { Flags } from '../../../const'

export function toFsFlag(flags: Flags): number {
  let result = 0

  const hasRead = (flags & Flags.read) !== 0
  const hasWrite = (flags & Flags.write) !== 0
  const hasAppend = (flags & Flags.append) !== 0

  // Access mode
  if (hasRead && hasWrite) {
    result |= fs.constants.O_RDWR
  } else if (hasWrite || hasAppend) {
    result |= fs.constants.O_WRONLY
  } else {
    result |= fs.constants.O_RDONLY
  }

  // Modifiers
  if (hasAppend) {
    result |= fs.constants.O_APPEND
  }
  if (flags & Flags.truncate) {
    result |= fs.constants.O_TRUNC
  }
  if (flags & Flags.create) {
    result |= fs.constants.O_CREAT
  }
  if (flags & Flags.exclude) {
    result |= fs.constants.O_EXCL
  }

  if (flags & Flags.sync) {
    result |= fs.constants.O_SYNC
  }

  return result
}

export function includePerm(value: Flags, perm: Flags): boolean {
  return (value & perm) === perm
}
