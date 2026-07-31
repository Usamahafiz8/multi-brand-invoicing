'use server';

import { redirect } from 'next/navigation';
import { deriveInvoicePrefix } from '@fenwick/shared';
import { DEFAULT_BRAND_COLOUR } from '@fenwick/shared/tokens';
import { ApiError, createBrand, type BrandFormInput, type CustomerAddress } from '@/lib/api';
import { defaultCurrencyFor, DEFAULT_COUNTRY } from '@/lib/geo';

export interface OnboardingState {
  readonly error?: string;
  /** Echoed back so a failed submit does not empty the form. */
  readonly values?: Record<string, string>;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function describeApiError(error: ApiError): string {
  const body = error.body as { issues?: Array<{ path: string; message: string }> } | null;
  if (body?.issues?.length) {
    return body.issues
      .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
      .join(' · ');
  }
  return error.message;
}

export async function createFirstBrandAction(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const legalName = emptyToNull(formData.get('legalName'));
  const country = emptyToNull(formData.get('country')) ?? DEFAULT_COUNTRY;

  // Echoed back on failure. The address fields are included so a validation
  // error on the name does not cost the operator the address they just typed.
  const values: Record<string, string> = {};
  for (const key of [
    'legalName',
    'salesPersonName',
    'phone',
    'email',
    'line1',
    'line2',
    'city',
    'region',
    'postalCode',
    'country',
  ]) {
    const value = formData.get(key);
    if (typeof value === 'string') values[key] = value;
  }

  if (!legalName) {
    return { error: 'Enter your legal brand name.', values };
  }

  const mailingAddress: CustomerAddress = {
    line1: emptyToNull(formData.get('line1')),
    line2: emptyToNull(formData.get('line2')),
    city: emptyToNull(formData.get('city')),
    region: emptyToNull(formData.get('region')),
    postalCode: emptyToNull(formData.get('postalCode')),
    country,
  };
  const hasAddress = Object.entries(mailingAddress).some(
    ([key, value]) => key !== 'country' && value !== null,
  );

  const input: BrandFormInput = {
    legalName,
    // The design collects one name. Display name is what appears on invoices
    // and in the brand switcher, and defaulting it to the legal name is right
    // far more often than not — Brand Setup is where it gets refined.
    displayName: legalName,
    salesPersonName: emptyToNull(formData.get('salesPersonName')),
    phone: emptyToNull(formData.get('phone')),
    email: emptyToNull(formData.get('email')),
    // A country on its own is the select's default, not something the operator
    // entered — sending it alone would store an address that is only a country.
    mailingAddress: hasAddress ? mailingAddress : null,
    billingAddress: null,
    taxId: null,
    currency: defaultCurrencyFor(country),
    // Not collected here. The IANA zone matters for invoice dates and due-date
    // arithmetic, so it cannot be left unset; Brand Setup is where it is chosen
    // deliberately rather than guessed from a browser (NFR-LOC-002).
    timezone: 'America/New_York',
    themeColor: DEFAULT_BRAND_COLOUR,
    invoicePrefix: deriveInvoicePrefix(legalName),
  };

  let brand;
  try {
    brand = await createBrand(input);
  } catch (error) {
    if (error instanceof ApiError) return { error: describeApiError(error), values };
    return { error: 'Could not create your brand. Try again.', values };
  }

  redirect(`/?brandId=${brand.id}&brandCreated=1`);
}
