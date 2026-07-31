'use client';

import { useCallback, useEffect, useState } from 'react';
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

interface BackfillCounts {
  customers: number;
  invoices: number;
  payments: number;
}

/**
 * Owns every Zoho action button plus the activity feed together, so clicking
 * one is reflected in the other immediately — no page reload, no redirect,
 * no "check back here": the click fires the request, the feed refreshes
 * right away instead of waiting for its own 4s tick, and polling keeps it
 * live from there whether or not anything is still running.
 */
export function ZohoLivePanel({
  brandId,
  connected,
  connectHref,
  initial,
}: {
  brandId: string;
  connected: boolean;
  connectHref: string;
  initial: ZohoActivityEntry[];
}) {
  const [entries, setEntries] = useState(initial);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const [pendingAction, setPendingAction] = useState<'sync' | 'pull' | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/settings/zoho/activity?brandId=${brandId}`, { cache: 'no-store' });
      if (!response.ok) return;
      setEntries((await response.json()) as ZohoActivityEntry[]);
      setLastPolledAt(new Date());
    } catch {
      // A missed poll just tries again on the next tick.
    }
  }, [brandId]);

  useEffect(() => {
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function runAction(kind: 'sync' | 'pull'): Promise<void> {
    setPendingAction(kind);
    setActionMessage(null);
    try {
      const path = kind === 'sync' ? 'backfill' : 'pull';
      const response = await fetch(`/settings/zoho/${path}?brandId=${brandId}`, { method: 'POST' });
      const body = (await response.json().catch(() => null)) as (BackfillCounts & { message?: string }) | null;

      if (!response.ok) {
        setActionMessage(body?.message ?? 'Could not queue this.');
      } else if (kind === 'sync' && body) {
        const nothingToDo = body.customers === 0 && body.invoices === 0 && body.payments === 0;
        setActionMessage(
          nothingToDo
            ? 'Nothing to queue — everything is already synced.'
            : `Queued ${body.customers} customer(s), ${body.invoices} invoice(s), ${body.payments} payment(s).`,
        );
      } else {
        setActionMessage('Pull queued — watch the feed below.');
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Could not reach the server.');
    } finally {
      setPendingAction(null);
      // Don't wait for the next 4s tick — the point of clicking is to see it
      // show up now.
      void refresh();
    }
  }

  const pendingCount = entries.filter((e) => e.status === 'RUNNING' || e.status === 'QUEUED').length;
  const succeededCount = entries.filter((e) => e.status === 'SUCCEEDED').length;
  const failedCount = entries.filter((e) => e.status === 'FAILED' || e.status === 'DEAD_LETTERED').length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={connectHref}
          className="inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
        >
          {connected ? 'Reconnect Zoho' : 'Connect Zoho'}
        </a>
        {connected && (
          <>
            <button
              type="button"
              onClick={() => runAction('sync')}
              disabled={pendingAction !== null}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-strong hover:bg-surface-muted disabled:opacity-60"
            >
              {pendingAction === 'sync' ? 'Queuing…' : 'Sync existing records'}
            </button>
            <button
              type="button"
              onClick={() => runAction('pull')}
              disabled={pendingAction !== null}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-strong hover:bg-surface-muted disabled:opacity-60"
            >
              {pendingAction === 'pull' ? 'Queuing…' : 'Pull from Zoho now'}
            </button>
          </>
        )}
      </div>

      {actionMessage && <p className="mt-3 text-sm text-ink-muted">{actionMessage}</p>}

      <p className="mt-3 text-xs text-ink-muted">
        {connected
          ? 'Sync existing records pushes anything not yet in Zoho. Pull from Zoho now fetches everything from your Zoho account — watch the feed below update live, no reload needed.'
          : "Connecting opens Zoho's own sign-in and consent screen — completing it needs your real Zoho account."}
      </p>

      {connected && (
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
              Every push and pull attempt, most recent first — Zoho&apos;s own message, verbatim,
              when one failed. This is what actually happened, not a summary.
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
              No activity yet — click a button above and it will appear here within a few seconds.
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
      )}
    </div>
  );
}
