'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CreditCard, LayoutDashboard, Plug, ScrollText, Users } from 'lucide-react';
import type { Brand } from '@/lib/api';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/invoices', label: 'Invoices', icon: ScrollText },
] as const;

const SETTINGS_ITEMS = [
  { href: '/settings/payment-methods', label: 'Payment methods', icon: CreditCard },
  { href: '/settings/zoho', label: 'Zoho Books', icon: Plug },
] as const;

/**
 * The one place brand selection lives. Every nav link carries the current
 * brandId forward, and switching brands keeps the current page — a merchant
 * comparing invoices across brands should not get bounced to the dashboard
 * every time they change brand.
 */
export function AdminShell({ brands, children }: { brands: Brand[]; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBrandId = searchParams.get('brandId') ?? brands[0]?.id ?? '';

  function hrefFor(path: string): string {
    return activeBrandId ? `${path}?brandId=${activeBrandId}` : path;
  }

  function isActive(path: string): boolean {
    return path === '/' ? pathname === '/' : pathname.startsWith(path);
  }

  function onBrandChange(brandId: string): void {
    const params = new URLSearchParams(searchParams.toString());
    params.set('brandId', brandId);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <p className="text-sm font-semibold text-ink-strong">Fenwick Invoicing</p>
          {brands.length > 0 && (
            <select
              aria-label="Switch brand"
              value={activeBrandId}
              onChange={(e) => onBrandChange(e.target.value)}
              className="mt-3 w-full rounded-md border border-border bg-surface-muted px-3 py-1.5 text-sm text-ink-strong"
            >
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.displayName}
                </option>
              ))}
            </select>
          )}
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={hrefFor(href)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                isActive(href)
                  ? 'bg-brand text-brand-foreground'
                  : 'text-ink-muted hover:bg-surface-muted hover:text-ink-strong'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          ))}

          <p className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Settings
          </p>
          {SETTINGS_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={hrefFor(href)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                isActive(href)
                  ? 'bg-brand text-brand-foreground'
                  : 'text-ink-muted hover:bg-surface-muted hover:text-ink-strong'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-border px-3 py-4">
          <Link
            href="/status"
            className="block rounded-md px-3 py-2 text-xs text-ink-subtle hover:text-ink-strong"
          >
            System status
          </Link>
        </div>
      </aside>

      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
