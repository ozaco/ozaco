import type { Operation } from 'std:effect'

import fs from 'node:fs/promises'

import type { Helpers } from '../../types/helpers'
import type { IODef } from '../../types/io'
import { toPath } from '../../utils/to-path'
import { fsCall } from '../fs/platform'

const isFile = (target: IODef.StdioTarget): target is IODef.StdioFile => typeof target !== 'string'

/**
 * Open the files a {@link Helpers.StdioConfig} names — `stdin` for reading, `stdout` / `stderr`
 * for writing (truncated, or appended with `append`; a missing one created with `mode`) — and
 * hand the spawn their descriptors. A file that cannot be opened fails like any fs call
 * (`std:io.not-found`, `std:io.access-denied`, …) after the ones already open were closed again.
 * The caller `close`s the handles right after the spawn: the child holds its own copies.
 */
export function* openStdio(config: Helpers.StdioConfig): Operation<Helpers.OpenStdio> {
  const handles: fs.FileHandle[] = []

  const close = function* () {
    for (const handle of handles.splice(0)) {
      yield* fsCall(handle.close())
    }
  }

  const open = function* (target: IODef.StdioTarget, flag: string): Operation<Helpers.StdioHandle> {
    if (!isFile(target)) {
      return target
    }

    const handle = yield* fsCall(
      fs.open(toPath(target.file), flag === 'r' ? 'r' : target.append ? 'a' : 'w', target.mode),
    )

    handles.push(handle)

    return handle.fd
  }

  try {
    return {
      stdin: yield* open(config.stdin, 'r'),
      stdout: yield* open(config.stdout, 'w'),
      stderr: yield* open(config.stderr, 'w'),
      close,
    }
  } catch (error) {
    yield* close()

    throw error
  }
}
