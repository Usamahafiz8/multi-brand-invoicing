import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fenwick — Invoicing',
  description: 'Multi-brand invoicing and payment administration.',
};

/**
 * Document shell only. The admin chrome — sidebar, brand switcher, sign-out —
 * lives in (app)/layout.tsx, because /login must render without any of it and
 * without being gated by the session check that layout performs.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
