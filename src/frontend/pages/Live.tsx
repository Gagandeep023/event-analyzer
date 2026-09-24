import React, { useState } from 'react';
import { useEventStream, type ApiContext } from '../hooks';
import { Panel } from '../components';
import { BarChart } from '../charts';
import { clockTime } from '../theme';

export function Live({ api }: { api: ApiContext }): React.ReactElement {
  const [paused, setPaused] = useState(false);
  const { events, connected, rate, freshId } = useEventStream(api, !paused);

  // Last 30 seconds is enough to see a pulse without turning into noise.
  const spark = rate.slice(-30).map((v, i) => ({ label: `${30 - i}s`, value: v }));
  const perMin = rate.reduce((n, v) => n + v, 0);

  return (
    <>
      <div className="ea-section">
        <Panel
          title="Throughput"
          aside={<span>{perMin} events in the last minute</span>}
        >
          <BarChart data={spark} height={120} />
        </Panel>
      </div>

      <Panel
        title={
          <span className="ea-live-head">
            <span className={`ea-live-dot${paused || !connected ? ' paused' : ''}`} />
            {paused ? 'Paused' : connected ? 'Receiving events' : 'Disconnected'}
          </span>
        }
        aside={
          <button type="button" className="ea-btn-outline" onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        }
      >
        {events.length === 0 ? (
          <p className="ea-empty">
            Nothing has arrived since this panel opened.
            {!connected && !paused ? ' The stream is not connected.' : ''}
          </p>
        ) : (
          <div>
            <div className="ea-live-row" style={{ color: 'var(--ea-muted)', fontSize: 12, borderTop: 'none' }}>
              <span>Time</span><span>Event</span><span>User</span><span>Properties</span>
            </div>
            {events.map((e) => (
              <div key={e.id} className={`ea-live-row${e.id === freshId ? ' fresh' : ''}`}>
                <span className="t">{clockTime(e.time)}</span>
                <span className="n">{e.event_type}</span>
                <span className="u">{e.user}</span>
                <span className="p" title={e.props}>{e.props}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
