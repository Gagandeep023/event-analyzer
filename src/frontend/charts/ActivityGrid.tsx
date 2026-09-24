/**
 * Day-of-week by hour-of-day grid.
 *
 * Answers "when are people actually here", which is the question behind when to
 * deploy, when to send, and whether a quiet Tuesday is normal.
 */

import React, { useState } from 'react';
import type { ActivityResult } from '../../types';
import { fmt } from '../theme';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function ActivityGrid({ data }: { data: ActivityResult }): React.ReactElement {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const peak = Math.max(1, data.peak);

  return (
    <div>
      <div className="ea-actgrid">
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          // Every third hour only; 24 labels in a row is unreadable.
          <div className="ea-actlab" key={h}>{h % 3 === 0 ? h : ''}</div>
        ))}

        {DAYS.map((label, d) => (
          <React.Fragment key={label}>
            <div className="ea-actday">{label}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data.cells[d]?.[h] ?? 0;
              const strength = v === 0 ? 0 : 8 + (v / peak) * 82;
              const on = hover?.d === d && hover?.h === h;
              return (
                <div
                  key={h}
                  className={`ea-actcell${on ? ' on' : ''}`}
                  title={`${label} ${String(h).padStart(2, '0')}:00 · ${fmt(v)}`}
                  style={{
                    background: v === 0
                      ? 'var(--ea-row-divider)'
                      : `color-mix(in oklch, oklch(0.55 0.13 250) ${strength.toFixed(0)}%, #fff)`,
                  }}
                  onMouseEnter={() => setHover({ d, h })}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>

      <p className="ea-actfoot">
        {hover
          ? `${DAYS[hover.d]} ${String(hover.h).padStart(2, '0')}:00 — ${fmt(data.cells[hover.d]?.[hover.h] ?? 0)} active`
          : data.busiest
            ? `Busiest: ${DAYS[data.busiest.day]} at ${String(data.busiest.hour).padStart(2, '0')}:00 (${fmt(data.busiest.value)} active)`
            : 'No activity in this range.'}
      </p>
    </div>
  );
}
