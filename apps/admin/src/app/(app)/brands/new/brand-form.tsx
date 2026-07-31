'use client';

import { useActionState } from 'react';
import { DEFAULT_BRAND_COLOUR } from '@fenwick/shared/tokens';
import { createBrandAction, type CreateBrandState } from './actions';

const initialState: CreateBrandState = {};

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-strong';
const labelClass = 'mb-1 block text-xs font-medium text-ink-muted';

function Field({
  label,
  name,
  ...rest
}: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input name={name} className={inputClass} {...rest} />
    </label>
  );
}

export function BrandForm() {
  const [state, formAction, pending] = useActionState(createBrandAction, initialState);

  return (
    <form action={formAction} className="space-y-8">
      <fieldset className="rounded-lg border border-border bg-surface p-6 shadow-sm">
        <legend className="px-1 text-sm font-medium text-ink-strong">Identity</legend>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label="Legal name" name="legalName" required />
          </div>
          <div className="col-span-2">
            <Field label="Display name" name="displayName" required />
          </div>
          <Field label="Sales person (optional)" name="salesPersonName" />
          <Field label="Tax ID (optional)" name="taxId" />
          <Field label="Email (optional)" name="email" type="email" />
          <Field label="Phone (optional)" name="phone" type="tel" />
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-border bg-surface p-6 shadow-sm">
        <legend className="px-1 text-sm font-medium text-ink-strong">Invoicing</legend>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field
            label="Invoice prefix (e.g. INV)"
            name="invoicePrefix"
            defaultValue="INV"
            maxLength={12}
            required
          />
          <Field label="Currency" name="currency" defaultValue="USD" maxLength={3} required />
          <Field label="Timezone" name="timezone" defaultValue="America/New_York" required />
          <label className="block">
            <span className={labelClass}>Theme colour</span>
            <input
              name="themeColor"
              type="color"
              defaultValue={DEFAULT_BRAND_COLOUR}
              className="h-10 w-full rounded-md border border-border bg-surface px-1"
            />
          </label>
        </div>
      </fieldset>

      {state.error && (
        <div className="rounded-md bg-danger-surface p-4 text-sm text-danger">{state.error}</div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground disabled:opacity-60"
        >
          {pending ? 'Creating…' : 'Create brand'}
        </button>
        <a href="/" className="text-sm text-ink-muted">
          Cancel
        </a>
      </div>
    </form>
  );
}
