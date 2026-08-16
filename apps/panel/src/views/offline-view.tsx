import { Button } from 'react-aria-components'

import { GearIcon, RefreshIcon } from '../components/icons'

/** Centered workspace state when the manifest endpoint is loading or unreachable. */
export const OfflineView = ({
  probeUrl,
  message,
  loading,
  onRetry,
  onOpenSettings,
}: {
  readonly probeUrl: string
  readonly message: string
  readonly loading: boolean
  readonly onRetry: () => void
  readonly onOpenSettings: () => void
}) => (
  <div className='flex h-full flex-col items-center justify-center gap-4 p-8 text-center'>
    <div className='flex flex-col items-center gap-1.5'>
      <h2 className='text-ink text-[15px] font-semibold'>
        {loading ? 'Loading manifest…' : 'No server reachable'}
      </h2>
      <p className='text-muted max-w-md text-[13px]'>
        {loading
          ? 'Probing the docs endpoint of the ozaco server.'
          : 'The panel could not load the docs manifest. Check that the server is running, then retry — or point the panel at a different base URL.'}
      </p>
    </div>
    <code className='border-line bg-panel text-ink rounded border px-3 py-1.5 font-mono text-[12.5px]'>
      {probeUrl}
    </code>
    {loading ? null : (
      <>
        <p className='text-danger max-w-md font-mono text-[12px]'>{message}</p>
        <div className='flex items-center gap-2'>
          <Button
            className='bg-accent text-accent-contrast flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-semibold data-hovered:opacity-90'
            onPress={onRetry}>
            <RefreshIcon />
            Retry
          </Button>
          <Button
            className='border-line text-muted data-hovered:text-ink flex items-center gap-1.5 rounded border px-3 py-1.5 text-[13px]'
            onPress={onOpenSettings}>
            <GearIcon />
            Open settings
          </Button>
        </div>
      </>
    )}
  </div>
)
