import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fenwick — Invoicing',
  description: 'Multi-brand invoicing and payment administration.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
