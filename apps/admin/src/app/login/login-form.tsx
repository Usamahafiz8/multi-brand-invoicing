'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';

const initialState: LoginState = {};

/**
 * Monochrome by design: this page is rendered before a brand is known, so there
 * is no brand colour to theme it with. Deliberately plain black and white rather
 * than the sage product palette the authenticated app uses.
 */
const inputClass =
  'w-full rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-md text-black ' +
  'placeholder:text-neutral-400 focus:border-black focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-1';

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={returnTo} />

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-neutral-700">Email address</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          defaultValue={state.email ?? ''}
          className={inputClass}
          placeholder="you@company.com"
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-neutral-700">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </label>

      {/* role="alert" so the failure is announced, not only shown (NFR-USE). */}
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2.5 text-sm text-black"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-black px-4 py-2.5 text-md font-medium text-white
                   transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black
                   focus-visible:ring-offset-2"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
