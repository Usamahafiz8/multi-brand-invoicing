import type { Metadata } from 'next';
import { Suspense } from 'react';
import './globals.css';
import { AdminShell } from '@/components/admin-shell';
import { listBrands, type Brand } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Fenwick — Invoicing',
  description: 'Multi-brand invoicing and payment administration.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let brands: Brand[] = [];
  try {
    brands = await listBrands();
  } catch {
    // The shell renders with no brands rather than crashing the whole app —
    // every page already has its own "API not reachable" handling for the
    // data it actually needs.
  }

  return (
    <html lang="en">
      <body className="min-h-full">
        <Suspense fallback={null}>
          <AdminShell brands={brands}>{children}</AdminShell>
        </Suspense>
      </body>
    </html>
  );
}
