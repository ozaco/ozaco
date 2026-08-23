import { useState } from 'react'

import type { Connection, Theme } from '../lib/config'

interface Props {
  readonly connection: Connection
  readonly theme: Theme
  readonly onSave: (next: {
    base: string
    docsPath: string
    token: string | null
    theme: Theme
  }) => void
  readonly onClose: () => void
}

export const SettingsDialog = ({ connection, theme, onSave, onClose }: Props) => {
  const [base, setBase] = useState(connection.base)
  const [docsPath, setDocsPath] = useState(connection.docsPath)
  const [token, setToken] = useState(connection.token ?? '')
  const [nextTheme, setNextTheme] = useState<Theme>(theme)
  return (
    <div
      className='fixed inset-0 z-20 flex items-center justify-center'
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}>
      <div
        className='w-[440px] rounded border p-4'
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
        onClick={event => event.stopPropagation()}>
        <div className='mb-3 font-semibold'>settings</div>
        <label className='mb-2 block'>
          <div style={{ color: 'var(--dim)' }}>api base</div>
          <input
            className='input mono'
            value={base}
            onChange={event => setBase(event.target.value)}
          />
        </label>
        <label className='mb-2 block'>
          <div style={{ color: 'var(--dim)' }}>
            docs path (manifest at &lt;docs path&gt;/manifest)
          </div>
          <input
            className='input mono'
            value={docsPath}
            onChange={event => setDocsPath(event.target.value)}
          />
        </label>
        <label className='mb-2 block'>
          <div style={{ color: 'var(--dim)' }}>
            bearer token (sent on every request and as ?token= on sockets)
          </div>
          <textarea
            className='input'
            rows={3}
            value={token}
            onChange={event => setToken(event.target.value)}
          />
        </label>
        <label className='mb-4 block'>
          <div style={{ color: 'var(--dim)' }}>theme</div>
          <select
            className='input'
            value={nextTheme}
            onChange={event => setNextTheme(event.target.value as Theme)}>
            <option value='dark'>dark</option>
            <option value='light'>light</option>
          </select>
        </label>
        <div className='flex justify-end gap-2'>
          <button className='btn' onClick={onClose}>
            cancel
          </button>
          <button
            className='btn btn-accent'
            onClick={() =>
              onSave({
                base: base.trim().replace(/\/$/u, ''),
                docsPath: docsPath.trim().replace(/\/$/u, '') || '/docs',
                token: token.trim() || null,
                theme: nextTheme,
              })
            }>
            save
          </button>
        </div>
      </div>
    </div>
  )
}
