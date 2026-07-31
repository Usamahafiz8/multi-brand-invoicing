'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The gateway's hosted-tokenization fields (library v0.3).
 *
 * The inputs rendered here are iframes served by the gateway from its own
 * origin. The card number is typed into the gateway's document, not ours, and
 * the only thing that ever crosses back is a short-lived nonce. That boundary
 * is the whole point: it is what keeps this app inside PCI SAQ A scope, and it
 * is why there is no <input> for a card number anywhere in this codebase.
 *
 * The nonce is valid for 15 minutes and is spent exactly once, by the API.
 */

/**
 * Shared across every field so the iframed inputs match the rest of the page.
 *
 * Deliberately carries no width: the library lays the expiry and CVV fields out
 * in a row by default, and forcing `width: 100%` on them stacks each onto its
 * own line and pushes CVV outside the iframe's viewport. Only the card number
 * field is widened, below.
 */
const FIELD_STYLE = [
  // Not optional: with the default content-box, width plus padding and a border
  // overflows the container.
  'box-sizing: border-box',
  'border: 1px solid #d8e0da',
  'border-radius: 6px',
  'padding: 8px 12px',
  'font-size: 14px',
  'font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  'color: #16261f',
].join('; ');

const CARD_FIELD_STYLE = `${FIELD_STYLE}; width: 100%`;

/**
 * The expiry and CVV inputs sit on one row and size to their own content, so
 * they need explicit widths wide enough for the placeholder text once the
 * horizontal padding is deducted — otherwise "CVV" renders clipped as "CV".
 */
const NARROW_FIELD_STYLE = `${FIELD_STYLE}; padding-left: 8px; padding-right: 8px; text-align: center`;
const EXPIRY_FIELD_STYLE = `${NARROW_FIELD_STYLE}; width: 3.25rem`;
const CVV_FIELD_STYLE = `${NARROW_FIELD_STYLE}; width: 4.25rem`;

export interface CardNonce {
  readonly nonce: string;
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
  readonly avsZip?: string;
}

/**
 * The shape `getNonceToken()` resolves to.
 *
 * The provider's own documentation disagrees with itself here: the v0.3 API
 * reference types CardFormResult with camelCase (`expiryMonth`), while the
 * setup example reads `result.expiry_month`. Both spellings are accepted below
 * rather than betting on one — guessing wrong would silently send a charge with
 * no expiry date, which the gateway may or may not reject.
 */
interface NonceResult {
  nonce: string;
  expiryMonth?: number;
  expiryYear?: number;
  avsZip?: string;
  expiry_month?: number;
  expiry_year?: number;
  avs_zip?: string;
}

/** The subset of the library's surface this component relies on. */
interface HostedTokenizationInstance {
  getNonceToken(): Promise<NonceResult>;
  on(event: string, handler: (event: { error?: string | null }) => void): HostedTokenizationInstance;
  setStyles(styles: Record<string, string>): void;
  setOptions(options: Record<string, unknown>): void;
}

type HostedTokenizationConstructor = new (
  publicKey: string,
  options: Record<string, unknown>,
) => HostedTokenizationInstance;

declare global {
  interface Window {
    HostedTokenization?: HostedTokenizationConstructor;
  }
}

/** Resolves once the library has been added to the page, loading it if needed. */
function loadLibrary(url: string): Promise<HostedTokenizationConstructor> {
  if (window.HostedTokenization) return Promise.resolve(window.HostedTokenization);

  return new Promise((resolve, reject) => {
    // A second mount must not inject a second copy of the script.
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${url}"]`);
    const script = existing ?? document.createElement('script');

    const onLoad = () => {
      if (window.HostedTokenization) resolve(window.HostedTokenization);
      else reject(new Error('the tokenization library loaded but exposed no HostedTokenization'));
    };

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('the tokenization library could not be loaded')),
      { once: true },
    );

    if (!existing) {
      script.src = url;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export function HostedCardFields({
  libraryUrl,
  publicKey,
  onReady,
}: {
  libraryUrl: string;
  publicKey: string;
  /** Hands the parent a function that mints a nonce from the current fields. */
  onReady: (getNonce: (() => Promise<CardNonce>) | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Kept in a ref rather than state: the parent gets it through onReady, and
  // re-rendering on every keystroke would tear down the iframes.
  const instanceRef = useRef<HostedTokenizationInstance | null>(null);

  const getNonce = useCallback(async (): Promise<CardNonce> => {
    const instance = instanceRef.current;
    if (!instance) throw new Error('the card fields are not ready yet');

    const result = await instance.getNonceToken();
    return {
      nonce: result.nonce,
      expiryMonth: result.expiryMonth ?? result.expiry_month,
      expiryYear: result.expiryYear ?? result.expiry_year,
      avsZip: result.avsZip ?? result.avs_zip,
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadLibrary(libraryUrl)
      .then((HostedTokenization) => {
        if (cancelled || !containerRef.current) return;

        const instance = new HostedTokenization(publicKey, {
          target: `#${containerRef.current.id}`,
          showFieldErrors: true,
          // Styles cross into the gateway's document as plain strings, so they
          // cannot use Tailwind classes or CSS variables — these are the token
          // values written out literally. `box-sizing: border-box` is not
          // optional: with content-box, `width: 100%` plus padding and a border
          // makes the card field overflow its iframe.
          styles: {
            cardContainer: 'margin-bottom: 8px;',
            card: CARD_FIELD_STYLE,
            expiryMonth: EXPIRY_FIELD_STYLE,
            expiryYear: EXPIRY_FIELD_STYLE,
            cvv2: CVV_FIELD_STYLE,
            avsZip: CVV_FIELD_STYLE,
            expirySeparator: 'padding: 0 6px; color: #5c6b62;',
            labels: 'font-size: 12px; color: #5c6b62;',
            fieldErrors: 'color: #b3261e; font-size: 12px; margin-top: 4px;',
          },
        });

        instance.on('change', (event) => {
          if (!cancelled) setFieldError(event.error ?? null);
        });

        instanceRef.current = instance;
        setReady(true);
        onReady(getNonce);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        // Tell the parent there is no way to pay by card, so it can disable the
        // button rather than let it fail on click.
        onReady(null);
      });

    return () => {
      cancelled = true;
      instanceRef.current = null;
      onReady(null);
    };
  }, [libraryUrl, publicKey, onReady, getNonce]);

  if (loadError) {
    return (
      <div className="rounded-md bg-danger-surface p-3 text-sm text-danger">
        We couldn&rsquo;t load the secure card form. Please refresh, or use another payment method.
      </div>
    );
  }

  return (
    <div>
      {/* The library injects its iframes into this element by id. */}
      <div id="hosted-card-fields" ref={containerRef} />
      {!ready && <p className="text-xs text-ink-subtle">Loading the secure card form…</p>}
      {fieldError && <p className="mt-2 text-xs text-danger">{fieldError}</p>}
      <p className="mt-3 text-xs text-ink-subtle">
        Card details are entered directly with our payment provider and never reach this site.
      </p>
    </div>
  );
}
