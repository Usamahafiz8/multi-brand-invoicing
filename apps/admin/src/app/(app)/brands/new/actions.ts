'use server';

import { redirect } from 'next/navigation';
import { ApiError, createBrand, type BrandFormInput } from '@/lib/api';
import { DEFAULT_BRAND_COLOUR } from '@fenwick/shared/tokens';

export interface CreateBrandState {
  readonly error?: string;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function describeApiError(error: ApiError): string {
  const body = error.body as { issues?: Array<{ path: string; message: string }> } | null;
  if (body?.issues?.length) {
    return body.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(' · ');
  }
  return error.message;
}

export async function createBrandAction(
  _prevState: CreateBrandState,
  formData: FormData,
): Promise<CreateBrandState> {
  const legalName = emptyToNull(formData.get('legalName'));
  const displayName = emptyToNull(formData.get('displayName'));
  const invoicePrefix = emptyToNull(formData.get('invoicePrefix'));

  if (!legalName) return { error: 'Legal name is required.' };
  if (!displayName) return { error: 'Display name is required.' };
  if (!invoicePrefix) return { error: 'Invoice prefix is required.' };

  const input: BrandFormInput = {
    legalName,
    displayName,
    salesPersonName: emptyToNull(formData.get('salesPersonName')),
    phone: emptyToNull(formData.get('phone')),
    email: emptyToNull(formData.get('email')),
    mailingAddress: null,
    billingAddress: null,
    taxId: emptyToNull(formData.get('taxId')),
    currency: emptyToNull(formData.get('currency')) ?? 'USD',
    timezone: emptyToNull(formData.get('timezone')) ?? 'America/New_York',
    themeColor: emptyToNull(formData.get('themeColor')) ?? DEFAULT_BRAND_COLOUR,
    invoicePrefix: invoicePrefix.toUpperCase(),
  };

  let created;
  try {
    created = await createBrand(input);
  } catch (error) {
    if (error instanceof ApiError) return { error: describeApiError(error) };
    return { error: error instanceof Error ? error.message : 'Could not create this brand.' };
  }

  redirect(`/?brandId=${created.id}&brandCreated=1`);
}
