/** The cluster pane: who serves what, and per-instance span stats over the window. */
import type { ClusterView } from '../lib/api'

export const ClusterPane = ({ view }: { view: ClusterView }) => (
  <div className='p-4'>
    <h2 className='m-0 text-[14px] font-semibold'>cluster</h2>
    <div style={{ color: 'var(--dim)' }}>since {new Date(view.since).toLocaleTimeString()}</div>

    <h3
      className='mt-4 mb-1.5 text-[12px] tracking-wider uppercase'
      style={{ color: 'var(--dim)' }}>
      members
    </h3>
    {Object.entries(view.members).map(([service, members]) => (
      <div key={service} className='py-[2px]'>
        <span className='tag'>{service}</span>
        {members.length === 0 && <span style={{ color: 'var(--bad)' }}>nobody</span>}
        {members.map((member, index) => (
          <span key={member.instance}>
            {index > 0 && <span style={{ color: 'var(--dim)' }}> · </span>}
            <span style={{ color: member.draining ? 'var(--bad)' : 'var(--ok)' }}>
              {member.instance}
            </span>{' '}
            <span style={{ color: 'var(--dim)' }}>
              {member.version}
              {member.draining ? ' draining' : ''}
            </span>
          </span>
        ))}
      </div>
    ))}

    <h3
      className='mt-4 mb-1.5 text-[12px] tracking-wider uppercase'
      style={{ color: 'var(--dim)' }}>
      instances
    </h3>
    <div className='grid grid-cols-[220px_1fr_70px] gap-2 py-[3px]' style={{ color: 'var(--dim)' }}>
      <span>instance</span>
      <span>spans · failed</span>
      <span className='text-right'>p95</span>
    </div>
    {view.instances.map(instance => (
      <div key={instance.instance} className='grid grid-cols-[220px_1fr_70px] gap-2 py-[3px]'>
        <span className='truncate'>
          {instance.instance} <span style={{ color: 'var(--dim)' }}>{instance.serviceId}</span>
        </span>
        <span>
          {instance.spans} ·{' '}
          <span style={{ color: instance.failed ? 'var(--bad)' : 'var(--ok)' }}>
            {instance.failed}
          </span>
        </span>
        <span className='text-right' style={{ color: 'var(--dim)' }}>
          {instance.p95Ms === null ? '' : `${instance.p95Ms}ms`}
        </span>
      </div>
    ))}
  </div>
)
