import { BrandForm } from './brand-form';

export const dynamic = 'force-dynamic';

export default function NewBrandPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-widest text-ink-subtle">Fenwick Holdings Inc.</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink-strong">Create a brand</h1>
        <p className="mt-2 text-ink-muted">
          Every customer, invoice and Zoho connection belongs to a brand — this is the first
          thing to create.
        </p>
      </header>
      <BrandForm />
    </main>
  );
}
