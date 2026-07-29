'use client';

import { useEffect, useRef, useState } from 'react';
import type { ZohoActivityEntry } from '@/lib/api';

const POLL_INTERVAL_MS = 4000;

function statusTone(status: string): string {
  if (status === 'SUCCEEDED') return 'text-success';
  if (status === 'FAILED' || status === 'DEAD_LETTERED') return 'text-danger';
  return 'text-ink-muted'; // QUEUED / RUNNING — pending, not yet a real result either way
}

function statusLabel(status: string): string {
  if (status === 'RUNNING') return 'PENDING — in progress';
  if (status === 'QUEUED') return 'PENDING — queued';
  return status;
}

/**
 * Polls rather than a single server-rendered snapshot, so a pull actually in
 * progress is visible changing in real time — RUNNING/QUEUED rows flipping
 * to SUCCEEDED or FAILED as jobs complete — without a manual page reload.
 * `initial` is what the server already fetched, so the first paint has no
 * loading flicker; polling only replaces it once a fresher read comes back.
 */
export function ActivityFeed({ brandId, initial }: { brandId: string; initial: ZohoActivityEntry[] }) {
  const [entries, setEntries] = useState(initial);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/settings/zoho/activity?brandId=${brandId}`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as ZohoActivityEntry[];
        setEntries(data);
        setLastPolledAt(new Date());
      } catch {
        // A missed poll just tries again on the next tick — nothing to show
        // the user for one dropped request.
      }
    }

    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [brandId]);

  const pendingCount = entries.filter((e) => e.status === 'RUNNING' || e.status === 'QUEUED').length;
  const succeededCount = entries.filter((e) => e.status === 'SUCCEEDED').length;
  const failedCount = entries.filter((e) => e.status === 'FAILED' || e.status === 'DEAD_LETTERED').length;

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface shadow-sm">
      <div className="border-b border-border px-5 py-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-ink-strong">Recent activity</h2>
          <span className="flex items-center gap-1 text-xs text-ink-subtle">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            live — updates every {POLL_INTERVAL_MS / 1000}s
          </span>
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">
          Every push and pull attempt, most recent first — Zoho&apos;s own message, verbatim, when
          one failed. This is what actually happened, not a summary.
        </p>
        <div className="mt-2 flex gap-4 text-xs">
          <span className="text-ink-muted">{pendingCount} pending</span>
          <span className="text-success">{succeededCount} succeeded (real, confirmed by Zoho)</span>
          <span className="text-danger">{failedCount} failed</span>
        </div>
        {lastPolledAt && (
          <p className="mt-1 text-[11px] text-ink-subtle">
            Last checked: {lastPolledAt.toLocaleTimeString()}
          </p>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-muted">
          No activity yet — click &ldquo;Sync existing records&rdquo; or &ldquo;Pull from Zoho
          now&rdquo; above and it will appear here live, no reload needed.
        </p>
      ) : (
      <ul className="divide-y divide-border">
        {entries.map((entry, i) => (
          <li key={i} className="px-5 py-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink-strong">
                {entry.direction === 'PUSH' ? '↑ Push' : '↓ Pull'} {entry.objectType.toLowerCase()}
              </span>
              <span className={`text-xs font-medium ${statusTone(entry.status)}`}>
                {statusLabel(entry.status)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-ink-muted">
              <span>{new Date(entry.updatedAt).toLocaleString()}</span>
              {entry.errorClass && <span className="font-mono">{entry.errorClass}</span>}
            </div>
            {entry.lastError && (
              <p className="mt-1 rounded-md bg-danger-surface px-2 py-1 font-mono text-xs text-danger">
                {entry.lastError}
              </p>
            )}
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}
