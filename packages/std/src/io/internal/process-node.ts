import { operation, until } from 'std:effect'
import { fail } from 'std:result'

import { spawn as childSpawn } from 'node:child_process'

import type {
  ExecOptions,
  ExecResult,
  ProcessHandle,
  ProcessStatus,
  SpawnOptions,
} from '../types/common'

import { fromReadable } from './from-readable'
import { concatBytes, errorMessage, makeStatus, normalizeSpawn, toBytes } from './process'

/**
 * Run a command to completion with `node:child_process`, buffering stdout/stderr. A non-zero exit
 * is data (reported on the {@link ExecResult}); only a spawn/runtime error becomes a `Result.Failure`.
 */
export const nodeExec = operation(function* (
  cmd: string,
  args?: readonly string[],
  options?: ExecOptions,
) {
  const config = normalizeSpawn(options)

  try {
    return yield* until(
      new Promise<ExecResult>((resolve, reject) => {
        const child = childSpawn(cmd, [...(args ?? [])], { ...config })
        const out: Uint8Array[] = []
        const err: Uint8Array[] = []

        child.stdout.on('data', chunk => out.push(new Uint8Array(chunk)))
        child.stderr.on('data', chunk => err.push(new Uint8Array(chunk)))
        child.once('error', reject)
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
    return yield* fail('exec-failed', `command "${cmd}" failed: ${errorMessage(error)}`)
  }
})

/**
 * Spawn a long-lived child process with `node:child_process`, exposing its streams and lifecycle as
 * effect primitives. A launch error (e.g. missing executable) is reported asynchronously through
 * `exited()` and the byte streams, since Node surfaces it after the handle is created.
 */
export const nodeSpawn = operation(function* (
  cmd: string,
  args?: readonly string[],
  options?: SpawnOptions,
) {
  const config = normalizeSpawn(options)

  let child
  try {
    child = childSpawn(cmd, [...(args ?? [])], { ...config })
  } catch (error) {
    return yield* fail('spawn-failed', `failed to spawn "${cmd}": ${errorMessage(error)}`)
  }

  // Attach the exit/error listeners eagerly: an unhandled 'error' event would otherwise crash the
  // process, and the settled promise is what `exited()` reads.
  const exitedPromise = new Promise<ProcessStatus>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve(makeStatus(code, signal)))
    child.once('error', reject)
  })
  void exitedPromise.catch(() => {})

  const exited = operation(function* () {
    try {
      return yield* until(exitedPromise)
    } catch (error) {
      return yield* fail('process-error', `process "${cmd}" errored: ${errorMessage(error)}`)
    }
  })

  const write = operation(function* (chunk: Uint8Array | string) {
    return yield* until(
      new Promise<void>((resolve, reject) => {
        child.stdin.write(toBytes(chunk), error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      }),
    )
  })

  const closeStdin = operation(function* () {
    return yield* until(
      new Promise<void>(resolve => {
        child.stdin.end(() => {
          resolve()
        })
      }),
    )
  })

  const kill = operation(function* (signal?: number | string) {
    const ok = child.kill(signal as NodeJS.Signals | number | undefined)
    if (!ok) {
      return yield* fail('kill-failed', `failed to signal pid ${child.pid ?? -1}`)
    }
  })

  const handle: ProcessHandle = {
    pid: child.pid ?? -1,
    stdout: fromReadable(child.stdout),
    stderr: fromReadable(child.stderr),
    exited,
    write,
    closeStdin,
    kill,
  }
  return handle
})
