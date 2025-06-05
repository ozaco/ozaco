import { join } from 'node:path'
import { $readFrom } from '@ozaco/std/io'

import './definition'
import './handler'
import { logger } from './consts'

const EMPTY_BUFFER = Buffer.from('')

Bun.serve({
  port: 3000,
  async fetch() {
    const reader = (await $readFrom(join(import.meta.dir, './example.txt'))).unwrap()

    let total = 0n
    let remainder = ''

    for await (const chunk of reader) {
      const data = chunk.else(EMPTY_BUFFER).toString()

      const currentData = remainder + data

      remainder = ''

      const splitted = currentData.split(',')
      if (data.at(-1) !== ',') {
        remainder = splitted.pop() || ''
      }

      for (const part of splitted) {
        if (part.trim() === '') {
          continue
        }

        total += BigInt(part)
      }
    }

    if (remainder.trim() !== '') {
      total += BigInt(remainder)
    }

    logger.log('total', total.toString())

    return new Response(total.toString())
  },
})

export * from './consts'
export * from './tag'
