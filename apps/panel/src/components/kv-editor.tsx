/** A key/value list editor (headers). */
export interface Pair {
  readonly key: string
  readonly value: string
  readonly on: boolean
}

export const pairsToRecord = (pairs: readonly Pair[]): Record<string, string> =>
  Object.fromEntries(
    pairs.filter(pair => pair.on && pair.key.trim()).map(pair => [pair.key.trim(), pair.value]),
  )

export const KvEditor = ({
  pairs,
  onChange,
}: {
  pairs: readonly Pair[]
  onChange: (next: Pair[]) => void
}) => {
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...patch } : pair)))
  return (
    <div className='flex flex-col gap-1 p-2'>
      {pairs.map((pair, index) => (
        <div key={index} className='flex items-center gap-1'>
          <input
            type='checkbox'
            checked={pair.on}
            onChange={event => update(index, { on: event.target.checked })}
          />
          <input
            className='input mono'
            placeholder='header'
            value={pair.key}
            onChange={event => update(index, { key: event.target.value })}
          />
          <input
            className='input mono'
            placeholder='value'
            value={pair.value}
            onChange={event => update(index, { value: event.target.value })}
          />
          <button
            className='btn'
            onClick={() => onChange(pairs.filter((_pair, at) => at !== index))}>
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          className='btn'
          onClick={() => onChange([...pairs, { key: '', value: '', on: true }])}>
          + header
        </button>
      </div>
    </div>
  )
}
