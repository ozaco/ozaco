import { mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

import { ioTags } from '../tag'

import { $fn } from '../../results'

export const $mkdir = $fn(async (path: string) => {
  await mkdir(path, { recursive: true })

  return true
}, ioTags.get('mkdir'))

export const $mkdirSync = $fn((path: string) => {
  mkdirSync(path, { recursive: true })

  return true
}, ioTags.get('mkdir'))
