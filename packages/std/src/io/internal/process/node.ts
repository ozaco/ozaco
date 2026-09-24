import { until } from 'std:effect'
import { fail } from 'std:result'

import { spawn as childSpawn } from 'node:child_process'

import { IOErrors } from '../../errors'
import type { IODef } from '../../types/io'
import { fromReadable } from '../stream/from-readable'

import {
  concatBytes,
  emptyByteFlow,
  errorMessage,
  inheritedStdinWrite,
  makeStatus,
  normalizeSpawn,
  resolveStdio,
  toBytes,
} from './shared'

/**
 * Run a command to completion with `node:child_process`, buffering stdout/stderr. A non-zero exit
 * is data (reported on the {@link IODef.ExecResult}); only a spawn/runtime error becomes a `Result.Failure`.
 */
export function* nodeExec(cmd: string, args?: readonly string[], options?: IODef.ExecOptions) {
  const config = normalizeSpawn(options)

  try {
    return yield* until(
      new Promise<IODef.ExecResult>((resolve, reject) => {
        const child = childSpawn(cmd, [...(args ?? [])], { ...config })
        const out: Uint8Array[] = []
        const err: Uint8Array[] = []

        child.stdout.on('data', chunk => out.push(new Uint8Array(chunk)))
        child.stderr.on('data', chunk => err.push(new Uint8Array(chunk)))
        child.once('error', reject)
        // a child that closes its read end before we finish writing emits EPIPE on child.stdin;
        // without a listener Node rethrows it as an uncaughtException and crashes the process. Route
        // it into `reject` — the promise settles once, so a clean `close` still wins the normal case.
        child.stdin.on('error', reject)
        child.once('close', (code, signal) =>
          resolve({
            ...makeStatus(code, signal),
            stdout: concatBytes(out),
            stderr: concatBytes(err),
          }),
        )

        if (options?.stdin === undefined) {
          child.stdin.end()
        } else {
          child.stdin.end(toBytes(options.stdin))
        }
      }),
    )
  } catch (error) {
    return yield* fail(IOErrors.ExecFailed, `command "${cmd}" failed: ${errorMessage(error)}`)
  }
}

/**
 * Spawn a long-lived child process with `node:child_process`, exposing its streams and lifecycle as
 * effect primitives. A launch error (e.g. missing executable) is reported asynchronously through
 * `exited()` and the byte streams, since Node surfaces it after the handle is created.
 */
export function* nodeSpawn(cmd: string, args?: readonly string[], options?: IODef.SpawnOptions) {
  const config = normalizeSpawn(options)
  const stdio = resolveStdio(options?.stdio)

  let child
  try {
    child = childSpawn(cmd, [...(args ?? [])], {
      ...config,
      stdio: [stdio.stdin, stdio.stdout, stdio.stderr],
    })
  } catch (error) {
    return yield* fail(IOErrors.SpawnFailed, `failed to spawn "${cmd}": ${errorMessage(error)}`)
  }

  // Attach the exit/error listeners eagerly: an unhandled 'error' event would otherwise crash the
  // process, and the settled promise is what `exited()` reads.
  const exitedPromise = new Promise<IODef.ProcessStatus>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve(makeStatus(code, signal)))
    child.once('error', reject)
  })
  void exitedPromise.catch(() => {})

  // guard against an unhandled 'error' on child.stdin (EPIPE when the child closed its read end):
  // `write()` surfaces the failure through its own callback; this listener only prevents the crash.
  // an inherited stream is `null` on the child — every use below checks
  const { stdin, stdout, stderr } = child
  stdin?.on('error', () => {})

  const exited = function* () {
    try {
      return yield* until(exitedPromise)
    } catch (error) {
      return yield* fail(IOErrors.ProcessError, `process "${cmd}" errored: ${errorMessage(error)}`)
    }
  }

  const write = function* (chunk: Uint8Array | string) {
    if (!stdin) {
      return yield* inheritedStdinWrite()
    }

    return yield* until(
      new Promise<void>((resolve, reject) => {
        stdin.write(toBytes(chunk), error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      }),
    )
  }

  const closeStdin = function* () {
    if (!stdin) {
      return
    }

    return yield* until(
      new Promise<void>(resolve => {
        stdin.end(() => {
          resolve()
        })
      }),
    )
  }

  const kill = function* (signal?: number | string) {
    const ok = child.kill(signal as NodeJS.Signals | number | undefined)

    if (!ok) {
      return yield* fail(IOErrors.KillFailed, `failed to signal pid ${child.pid ?? -1}`)
    }
  }

  const handle: IODef.ProcessHandle = {
    pid: child.pid ?? -1,
    stdout: stdout ? fromReadable(stdout) : emptyByteFlow(),
    stderr: stderr ? fromReadable(stderr) : emptyByteFlow(),
    exited,
    write,
    closeStdin,
    kill,
  }
  return handle
}
