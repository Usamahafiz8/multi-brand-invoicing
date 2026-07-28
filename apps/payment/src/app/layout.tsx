import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pay invoice',
  // The page is not indexable and reveals no brand until a valid token
  // resolves to one.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
