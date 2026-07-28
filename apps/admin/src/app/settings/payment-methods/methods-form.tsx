'use client';

import { useActionState, useState } from 'react';
import type { PaymentMethodSettings } from '@/lib/api';
import { updatePaymentMethodsAction, type ToggleMethodsState } from './actions';

const initialState: ToggleMethodsState = {};

function Toggle({
  name,
  label,
  hint,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <span>
        <span className="block text-sm font-medium text-ink-strong">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-muted">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center pt-0.5">
        {/* No hidden fallback needed: an unchecked box is simply absent from
            FormData, and the action reads that absence as false directly —
            adding one under the same name would only risk shadowing the
            checked value ahead of it in DOM order. */}
        <input
          type="checkbox"
          name={name}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-surface-muted checked:bg-brand relative before:absolute before:left-0.5 before:top-0.5 before:h-4 before:w-4 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-4"
        />
      </span>
    </label>
  );
}

export function MethodsForm({ brandId, initial }: { brandId: string; initial: PaymentMethodSettings }) {
  const [state, formAction, pending] = useActionState(updatePaymentMethodsAction, initialState);
  const [settings, setSettings] = useState(initial);

  function set<K extends keyof PaymentMethodSettings>(key: K, value: boolean) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  const anyEnabled = Object.values(settings).some(Boolean);

  return (
    <form action={formAction}>
      <input type="hidden" name="brandId" value={brandId} />

      <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
        <Toggle
          name="cardEnabled"
          label="Credit & debit card"
          hint="Routes through Numbers Gateway once connected (DEP-01) — FakeGateway locally."
          checked={settings.cardEnabled}
          onChange={(v) => set('cardEnabled', v)}
        />
        <Toggle
          name="applePayEnabled"
          label="Apple Pay"
          hint="Also needs Apple domain verification and a merchant identity certificate — turning this on alone does not make the real button appear yet."
          checked={settings.applePayEnabled}
          onChange={(v) => set('applePayEnabled', v)}
        />
        <Toggle
          name="googlePayEnabled"
          label="Google Pay"
          hint="Also needs a registered Google Pay merchant ID — same caveat as Apple Pay."
          checked={settings.googlePayEnabled}
          onChange={(v) => set('googlePayEnabled', v)}
        />
        <Toggle
          name="achEnabled"
          label="Bank transfer (ACH)"
          hint="No card fee applies to this method."
          checked={settings.achEnabled}
          onChange={(v) => set('achEnabled', v)}
        />
        <Toggle
          name="checkEnabled"
          label="Manual check upload"
          hint="Not wired up in the payment app yet — enabling this has no visible effect today."
          checked={settings.checkEnabled}
          onChange={(v) => set('checkEnabled', v)}
        />
      </div>

      {!anyEnabled && (
        <div className="mt-4 rounded-md bg-danger-surface p-3 text-sm text-danger">
          At least one method must stay enabled, or every invoice for this brand becomes unpayable.
        </div>
      )}
      {state.error && (
        <div className="mt-4 rounded-md bg-danger-surface p-3 text-sm text-danger">{state.error}</div>
      )}

      <button
        type="submit"
        disabled={pending || !anyEnabled}
        className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
