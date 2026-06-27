import { IO } from 'std:io'

export const ENV = IO.actions.env(data => ({
  columns: data.COLUMNS ?? null,
  rows: data.LINES ?? null,
}))
