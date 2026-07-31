/**
 * Invoice prefix derivation.
 *
 * Onboarding asks for a legal name and nothing else, but every brand needs an
 * invoice prefix before it can number an invoice. This turns the one into the
 * other so the common case needs no thought — "Prime Shelf Space Inc." becomes
 * PSS — and Brand Setup is where it gets overridden.
 *
 * The output must satisfy brandSettingsSchema.invoicePrefix: 1–12 characters,
 * A–Z, 0–9 and hyphens only. That is the contract this file exists to keep, and
 * why it lives beside the schema rather than in the admin app that calls it.
 */

/** Words that carry no identity and would only dilute the initials. */
const NOISE = /^(inc|llc|ltd|limited|co|corp|corporation|company|group|holdings|the|and|of)$/i;

export const FALLBACK_INVOICE_PREFIX = 'INV';
const MAX_LENGTH = 6;

export function deriveInvoicePrefix(legalName: string): string {
  // Apostrophes join, everything else separates. "O'Brien" is one word and
  // must yield O, not OB; "Smith & Sons" is two and must yield SS. Collapsing
  // both to the same rule gets one of them wrong, so they are handled apart.
  const words = legalName
    .replace(/['’]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  const meaningful = words.filter((word) => !NOISE.test(word));
  const source = meaningful.length > 0 ? meaningful : words;

  const initials = source
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, MAX_LENGTH);

  // A single-word name gives one initial, which is too thin to read on an
  // invoice — take the opening letters of the word itself instead.
  if (initials.length >= 2) return initials;
  if (source.length === 1) {
    const opening = source[0]!.toUpperCase().slice(0, 4);
    if (opening.length >= 2) return opening;
  }

  // Nothing in the Latin range survived — a name written entirely in another
  // script reaches here, and needs a prefix that at least validates.
  return FALLBACK_INVOICE_PREFIX;
}
