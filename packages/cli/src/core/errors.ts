import { createTags } from 'std:shared'

/**
 * The single cli error taxonomy — every failure surfaced by a cli module (terminal impls, prompts,
 * spinners, tables, the command runner) is a Result failure carrying one of these tags (nothing
 * throws).
 *
 * - `terminal` — a terminal-plumbing failure (no active session, released render lease, …)
 * - `unsupported` — the installed terminal lacks the capability (e.g. `resize` without a tty)
 * - `cancelled` — the user cancelled (ctrl+c / esc inside a prompt, SIGINT inside a session)
 * - `not-interactive` — an interactive feature was invoked on a non-interactive terminal
 * - `busy` — the live region is already leased (`renderer()` without `{ wait: true }`)
 * - `parse` — argv did not parse/validate against the action's input schema
 * - `unknown` — an unregistered command was requested
 * - `validation` — a value failed a cli-side validation outside argv parsing
 */
export const CliErrors = createTags(
  'cli',
  'terminal',
  'unsupported',
  'cancelled',
  'not-interactive',
  'busy',
  'parse',
  'unknown',
  'validation',
)
