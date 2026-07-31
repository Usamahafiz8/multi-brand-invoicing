'use client';

import { useActionState, useState } from 'react';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  postalLabel,
  subdivisionLabel,
  subdivisionsFor,
} from '@/lib/geo';
import { createFirstBrandAction, type OnboardingState } from './actions';

const initialState: OnboardingState = {};

const fieldClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink-strong ' +
  'placeholder:text-ink-subtle focus:border-ink focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1';

const labelClass = 'mb-1.5 block text-xs font-semibold text-ink-strong';

function Field({
  label,
  name,
  ...rest
}: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input name={name} className={fieldClass} {...rest} />
    </label>
  );
}

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(createFirstBrandAction, initialState);
  const [country, setCountry] = useState(state.values?.['country'] ?? DEFAULT_COUNTRY);

  const previous = state.values ?? {};
  const subdivisions = subdivisionsFor(country);

  return (
    <form action={formAction} className="space-y-5">
      <Field
        label="Legal Name"
        name="legalName"
        placeholder="Enter your legal brand name"
        autoFocus
        required
        maxLength={200}
        defaultValue={previous['legalName'] ?? ''}
      />
      <Field
        label="Sales Person"
        name="salesPersonName"
        placeholder="Enter sales person full name"
        maxLength={160}
        defaultValue={previous['salesPersonName'] ?? ''}
      />
      <Field
        label="Phone Number"
        name="phone"
        type="tel"
        placeholder="Enter phone number"
        defaultValue={previous['phone'] ?? ''}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        placeholder="Enter email address"
        defaultValue={previous['email'] ?? ''}
      />

      <fieldset className="space-y-2.5 pt-1">
        <legend className={labelClass}>Mailing Address</legend>

        <input
          name="line1"
          className={fieldClass}
          placeholder="Address line 1"
          aria-label="Address line 1"
          maxLength={200}
          defaultValue={previous['line1'] ?? ''}
        />
        <input
          name="line2"
          className={fieldClass}
          placeholder="Address line 2 (optional)"
          aria-label="Address line 2"
          maxLength={200}
          defaultValue={previous['line2'] ?? ''}
        />

        <div className="grid grid-cols-3 gap-2.5">
          <input
            name="city"
            className={fieldClass}
            placeholder="City"
            aria-label="City"
            maxLength={120}
            defaultValue={previous['city'] ?? ''}
          />

          {/* A dropdown only where the list is genuinely complete; elsewhere a
              free-text box, because a select missing the user's region is worse
              than one they can type into. */}
          {subdivisions ? (
            <select
              name="region"
              aria-label={subdivisionLabel(country)}
              className={fieldClass}
              defaultValue={previous['region'] ?? ''}
            >
              <option value="">{subdivisionLabel(country)}</option>
              {subdivisions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              name="region"
              className={fieldClass}
              placeholder={subdivisionLabel(country)}
              aria-label={subdivisionLabel(country)}
              maxLength={120}
              defaultValue={previous['region'] ?? ''}
            />
          )}

          <input
            name="postalCode"
            className={fieldClass}
            placeholder={postalLabel(country)}
            aria-label={postalLabel(country)}
            maxLength={32}
            defaultValue={previous['postalCode'] ?? ''}
          />
        </div>

        <select
          name="country"
          aria-label="Country"
          className={fieldClass}
          value={country}
          onChange={(event) => setCountry(event.target.value)}
        >
          {COUNTRIES.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
      </fieldset>

      {state.error && (
        <p role="alert" className="rounded-md border border-border bg-surface-muted px-3 py-2.5 text-sm text-ink-strong">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-ink-inverse
                   transition hover:bg-ink-strong disabled:cursor-not-allowed disabled:bg-border-strong
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink
                   focus-visible:ring-offset-2"
      >
        {pending ? 'Creating…' : 'Create Brand'}
      </button>
    </form>
  );
}
