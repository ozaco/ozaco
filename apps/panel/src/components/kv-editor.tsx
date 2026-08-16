import { Button, Input, Label, TextField } from 'react-aria-components'

import { PlusIcon, TrashIcon } from './icons'

/** Key/value row editor (extra request headers). Rows with an empty key are ignored on send. */

let rowSeq = 0

const FIELD =
  'border-line bg-surface text-ink data-focused:border-accent w-full rounded border px-2 py-1 font-mono text-[12px]'

export interface KvRow {
  readonly id: string
  readonly key: string
  readonly value: string
}

export const createKvRow = (): KvRow => {
  rowSeq += 1

  return { id: `kv${rowSeq}`, key: '', value: '' }
}

/** Non-empty keys folded into a record (later rows win on duplicate keys). */
export const kvToRecord = (rows: readonly KvRow[]): Record<string, string> => {
  const record: Record<string, string> = {}

  for (const row of rows) {
    const key = row.key.trim()

    if (key !== '') {
      record[key] = row.value
    }
  }

  return record
}

export const KvEditor = ({
  rows,
  onChange,
  keyPlaceholder = 'name',
  valuePlaceholder = 'value',
  addLabel = 'Add row',
}: {
  readonly rows: readonly KvRow[]
  readonly onChange: (rows: readonly KvRow[]) => void
  readonly keyPlaceholder?: string
  readonly valuePlaceholder?: string
  readonly addLabel?: string
}) => {
  const patch = (id: string, part: Partial<Pick<KvRow, 'key' | 'value'>>): void => {
    onChange(rows.map(row => (row.id === id ? { ...row, ...part } : row)))
  }

  return (
    <div className='flex flex-col gap-1'>
      {rows.map(row => (
        <div key={row.id} className='flex items-center gap-1.5'>
          <TextField
            aria-label='Name'
            className='w-44 shrink-0'
            onChange={key => patch(row.id, { key })}
            value={row.key}>
            <Label className='sr-only'>Name</Label>
            <Input className={FIELD} placeholder={keyPlaceholder} />
          </TextField>
          <TextField
            aria-label='Value'
            className='min-w-0 flex-1'
            onChange={value => patch(row.id, { value })}
            value={row.value}>
            <Label className='sr-only'>Value</Label>
            <Input className={FIELD} placeholder={valuePlaceholder} />
          </TextField>
          <Button
            aria-label='Remove row'
            className='text-muted data-hovered:text-danger shrink-0 rounded p-1'
            onPress={() => onChange(rows.filter(candidate => candidate.id !== row.id))}>
            <TrashIcon />
          </Button>
        </div>
      ))}
      <div>
        <Button
          className='border-line text-muted data-hovered:text-ink data-hovered:border-accent/50 flex items-center gap-1 rounded border px-2 py-1 text-[12px]'
          onPress={() => onChange([...rows, createKvRow()])}>
          <PlusIcon height={11} width={11} />
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
