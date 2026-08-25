import { JsonTree } from '../components/json-tree'
import type { Manifest } from '../lib/ozaco'

export const ManifestTab = ({ manifest }: { manifest: Manifest }) => (
  <div className='h-full overflow-auto p-3'>
    <div className='mb-2' style={{ color: 'var(--dim)' }}>
      {manifest.name} {manifest.version} · instance {manifest.instance} · {manifest.services.length}{' '}
      service(s)
    </div>
    <JsonTree value={manifest} />
  </div>
)
