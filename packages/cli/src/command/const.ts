import { createTags } from 'std:shared'

export const ACTION = Symbol.for('cli:command:action')
export const COMMAND = Symbol.for('cli:command:command')

export const HELP_FLAGS = ['--help', '-h']
export const VERSION_FLAGS = ['--version', '-V']

export const CommandErrors = createTags('cli:command', 'parse', 'required', 'invalid', 'unknown')
