import { operation, until } from 'std:effect'
import { fail } from 'std:result'

import type {
  ExecOptions,
  ExecResult,
  ProcessHandle,
  SpawnOptions,
  WebReadableLike,
} from '../types/common'

import { fromReadable } from './from-readable'
import { errorMessage, makeStatus, normalizeSpawn, toBytes } from './process'

/**
 * Run a command to completion with `Bun.spawn`, buffering stdout/stderr. A non-zero exit is data
 * (reported on the {@link ExecResult}), not a failure — only an inability to launch the process (or
 * a runtime error draining it) surfaces as a `Result.Failure`.
 */
export const bunExec = operation(function* (
  cmd: string,
  args?: readonly string[],
  options?: ExecOptions,
) {
  const config = normalizeSpawn(options)

  let proc
  try {
    proc = Bun.spawn([cmd, ...(args ?? [])], {
      ...config,
      stdin: options?.stdin === undefined ? 'ignore' : toBytes(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return yield* fail('exec-spawn-failed', `failed to spawn "${cmd}": ${errorMessage(error)}`)
  }

  try {
    const [out, err] = yield* until(
      Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
        proc.exited,
      ]),
    )
    const result: ExecResult = {
      ...makeStatus(proc.exitCode, proc.signalCode),
      stdout: new Uint8Array(out),
      stderr: new Uint8Array(err),
    }
    return result
  } catch (error) {
    return yield* fail('exec-failed', `command "${cmd}" failed: ${errorMessage(error)}`)
  }
})

/**
 * Spawn a long-lived child process with `Bun.spawn`, exposing its streams and lifecycle as effect
 * primitives. stdin/stdout/stderr are piped; consume (or `kill`) the handle within the spawning
 * scope.
 */
export const bunSpawn = operation(function* (
  cmd: string,
  args?: readonly string[],
  options?: SpawnOptions,
) {
  const config = normalizeSpawn(options)

  let proc
  try {
    proc = Bun.spawn([cmd, ...(args ?? [])], {
      ...config,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return yield* fail('spawn-failed', `failed to spawn "${cmd}": ${errorMessage(error)}`)
  }

  const exited = operation(function* () {
    yield* until(proc.exited)
    return makeStatus(proc.exitCode, proc.signalCode)
  })

  const write = operation(function* (chunk: Uint8Array | string) {
    try {
      proc.stdin.write(toBytes(chunk))
      yield* until(Promise.resolve(proc.stdin.flush()))
    } catch (error) {
      return yield* fail('stdin-write-failed', `failed to write stdin: ${errorMessage(error)}`)
    }
  })

  const closeStdin = operation(function* () {
    yield* until(Promise.resolve(proc.stdin.end()))
  })

  const kill = operation(function* (signal?: number | string) {
    try {
      proc.kill(signal as number | undefined)
    } catch (error) {
      return yield* fail('kill-failed', `failed to kill pid ${proc.pid}: ${errorMessage(error)}`)
    }
  })

  const handle: ProcessHandle = {
    pid: proc.pid,
    stdout: fromReadable(proc.stdout.getReader() as WebReadableLike),
    stderr: fromReadable(proc.stderr.getReader() as WebReadableLike),
    exited,
    write,
    closeStdin,
    kill,
  }
  return handle
})
