import { describe, expect, it } from 'bun:test'

describe('lifecycle', () => {
  it('the full stack shuts down gracefully and the process exits naturally', async () => {
    const child = Bun.spawn(
      [process.execPath, new URL('fixtures/shutdown.ts', import.meta.url).pathname],
      {
        cwd: new URL('..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const killer = setTimeout(() => {
      child.kill()
    }, 8000)

    const exitCode = await child.exited

    clearTimeout(killer)

    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()

    expect(stderr).toBe('')
    expect(stdout).toContain('request-done')
    expect(stdout).toContain('socket-open')
    expect(stdout).toContain('stack-stopped')
    expect(stdout.trim().endsWith('all-done')).toBe(true)
    expect(exitCode).toBe(0)
  }, 10_000)
})
