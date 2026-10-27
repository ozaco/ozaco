import type { Operation } from 'std:effect'
import { attempt, ensure, sleep } from 'std:effect'
import { toPath } from 'std:io'
import { fail, isFailure } from 'std:result'

import fs from 'node:fs/promises'
import { join } from 'node:path'

import { IOErrors } from '../../errors'
import type { IODef } from '../../types/io'
import { fsCall } from '../fs/platform'

import { processAlive } from './pid'

const LOCK_FILE = 'lock.json'

/** What a rename onto a lock somebody holds says: the directory is there (POSIX `ENOTEMPTY` /
 * `EEXIST`, Windows `EPERM` / `EBUSY`). */
const HELD: ReadonlySet<string> = new Set([
  IOErrors.Exists,
  IOErrors.NotEmpty,
  IOErrors.AccessDenied,
  IOErrors.Busy,
])

/** The holder a lock directory names — `null` when the file is missing or unreadable. */
function* holderOf(path: string): Operation<IODef.LockHolder | null> {
  const text = yield* attempt(() => fsCall(fs.readFile(join(path, LOCK_FILE), 'utf8')))

  if (isFailure(text)) {
    return null
  }

  try {
    const parsed = JSON.parse(text.value) as Partial<IODef.LockHolder> | null

    return parsed && typeof parsed.pid === 'number'
      ? { pid: parsed.pid, startedAt: Number(parsed.startedAt ?? 0), record: parsed.record }
      : null
  } catch {
    return null
  }
}

/** Stage a directory with the holder's record, then rename it INTO place — one atomic step that
 * either takes the lock or hits whoever holds it. */
function* claim(path: string, holder: IODef.LockHolder): Operation<boolean> {
  const staged = `${path}.${holder.pid}-${Date.now()}`

  yield* fsCall(fs.mkdir(staged, { recursive: true }))
  yield* fsCall(fs.writeFile(join(staged, LOCK_FILE), JSON.stringify(holder)))

  const placed = yield* attempt(() => fsCall(fs.rename(staged, path)))

  if (!isFailure(placed)) {
    return true
  }

  yield* fsCall(fs.rm(staged, { recursive: true, force: true }))

  if (HELD.has(placed.error as string)) {
    return false
  }

  return yield* placed
}

/** `IO.actions.lock` — see the protocol's doc. */
export function* lock(target: IODef.PathLike, options?: IODef.LockOptions): Operation<IODef.Lock> {
  const path = toPath(target)
  const holder: IODef.LockHolder = {
    pid: process.pid,
    startedAt: Math.floor(performance.timeOrigin),
    record: options?.record,
  }
  const deadline = Date.now() + (options?.waitMs ?? 0)
  const pollMs = options?.pollMs ?? 100

  for (;;) {
    if (yield* claim(path, holder)) {
      break
    }

    const current = yield* holderOf(path)

    // a dead holder's lock is stale: swept, then claimed like any other
    if (current && !(yield* processAlive(current.pid))) {
      yield* fsCall(fs.rm(path, { recursive: true, force: true }))

      continue
    }

    if (Date.now() >= deadline) {
      return yield* fail(
        IOErrors.Busy,
        current
          ? `${path} is held by pid ${current.pid}`
          : `${path} is held (the holder could not be read)`,
        'lock:held',
      )
    }

    yield* sleep(pollMs)
  }

  let released = false

  const release = function* (): Operation<void> {
    if (released) {
      return
    }

    released = true

    // only OUR lock is removed: a stale sweep by somebody else may have replaced it meanwhile
    const current = yield* holderOf(path)

    if (current?.pid === holder.pid && current.startedAt === holder.startedAt) {
      yield* fsCall(fs.rm(path, { recursive: true, force: true }))
    }
  }

  yield* ensure(() => release())

  return { path, holder, release }
}
