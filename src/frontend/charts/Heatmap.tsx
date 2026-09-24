/**
 * Retention cohort grid.
 *
 * A table, not a chart. Cohort grids are tabular data, and forcing them through
 * a charting library produces something that cannot be read or copied. Cells
 * that the range cannot yet observe are rendered muted rather than dropped, so
 * a thin tail reads as "not measured" instead of "nobody came back".
 */

import React from 'react';
import type { RetentionResult } from '../../types';
import { pct } from '../theme';

export function Heatmap({ data, periods = 8 }: { data: RetentionResult; periods?: number }): React.ReactElement {
  const cols = Math.min(periods, Math.max(1, data.curve.length));
  const label = data.interval === 'day' ? 'D' : data.interval === 'week' ? 'W' : 'M';

  return (
    <div className="ea-heat-scroll">
      <div className="ea-heat" style={{ gridTemplateColumns: `120px 70px repeat(${cols}, minmax(52px, 1fr))` }}>
        <div className="h">Cohort</div>
        <div className="h" style={{ textAlign: 'right' }}>Users</div>
        {Array.from({ length: cols }, (_, i) => <div className="h" key={i} style={{ textAlign: 'center' }}>{label}{i}</div>)}

        {data.table.slice(-12).map((row) => (
          <React.Fragment key={row.cohortStart}>
            <div className="lab">{row.cohortLabel}</div>
            <div className="cnt">{row.cohortSize.toLocaleString()}</div>
            {Array.from({ length: cols }, (_, i) => {
              const cell = row.cells[i];
              if (!cell) return <div className="c none" key={i} />;
              if (cell.incomplete) {
                return (
                  <div className="c none" key={i} title="Not enough elapsed time to measure fairly">
                    &middot;
                  </div>
                );
              }
              const strength = 8 + cell.rate * 82;
              return (
                <div
                  className="c"
                  key={i}
                  title={`${cell.retained.toLocaleString()} of ${row.cohortSize.toLocaleString()}`}
                  style={{
                    background: `color-mix(in oklch, oklch(0.55 0.13 250) ${strength.toFixed(0)}%, #fff)`,
                    color: strength > 70 ? '#fff' : '#1C1B19',
                  }}
                >
                  {pct(cell.rate, 0)}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
