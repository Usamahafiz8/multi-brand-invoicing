'use server';

import { redirect } from 'next/navigation';
import { ApiError, createCustomer, type CustomerAddress, type CustomerFormInput } from '@/lib/api';

export interface CreateCustomerState {
  readonly error?: string;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readAddress(formData: FormData, prefix: string): CustomerAddress | null {
  const address: CustomerAddress = {
    line1: emptyToNull(formData.get(`${prefix}Line1`)),
    line2: emptyToNull(formData.get(`${prefix}Line2`)),
    city: emptyToNull(formData.get(`${prefix}City`)),
    region: emptyToNull(formData.get(`${prefix}Region`)),
    postalCode: emptyToNull(formData.get(`${prefix}PostalCode`)),
    country: emptyToNull(formData.get(`${prefix}Country`)),
  };
  return Object.values(address).some((v) => v !== null) ? address : null;
}

function describeApiError(error: ApiError): string {
  const body = error.body as { issues?: Array<{ path: string; message: string }> } | null;
  if (body?.issues?.length) {
    return body.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(' · ');
  }
  return error.message;
}

/**
 * Server Action, invoked directly as the form's action prop — works with
 * useActionState so validation failures render inline instead of hitting the
 * nearest error boundary. Only the success path leaves this function (via
 * redirect, which Next.js implements as a thrown control-flow signal — that
 * is not caught by the try/catch below, by design).
 */
export async function createCustomerAction(
  _prevState: CreateCustomerState,
  formData: FormData,
): Promise<CreateCustomerState> {
  const brandId = emptyToNull(formData.get('brandId'));
  if (!brandId) return { error: 'No brand selected.' };

  const type = formData.get('type') === 'INDIVIDUAL' ? 'INDIVIDUAL' : 'BUSINESS';
  const companyName = emptyToNull(formData.get('companyName'));
  const firstName = emptyToNull(formData.get('firstName'));
  const lastName = emptyToNull(formData.get('lastName'));

  // FR-CUS-005: default the display name rather than force the user to
  // re-type what they already entered. `.join(' ')` always returns a string
  // (possibly empty), so the empty case is checked explicitly rather than
  // relying on `??`, which only catches null/undefined.
  const joinedName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const displayName = emptyToNull(formData.get('displayName')) ?? companyName ?? (joinedName || null);

  if (!displayName) {
    return { error: 'Enter a company name, a contact name, or a display name.' };
  }
  if (type === 'BUSINESS' && !companyName) {
    return { error: 'A business customer needs a company name.' };
  }
  if (type === 'INDIVIDUAL' && !firstName && !lastName) {
    return { error: 'An individual customer needs a first or last name.' };
  }

  const billingAddress = readAddress(formData, 'billing');
  const shippingAddress =
    formData.get('sameAsBilling') === 'on' ? billingAddress : readAddress(formData, 'shipping');

  const input: CustomerFormInput = {
    type,
    salutation: emptyToNull(formData.get('salutation')),
    firstName,
    lastName,
    companyName,
    displayName,
    email: emptyToNull(formData.get('email')),
    phone: emptyToNull(formData.get('phone')),
    billingAddress,
    shippingAddress,
  };

  let created;
  try {
    created = await createCustomer(brandId, input);
  } catch (error) {
    if (error instanceof ApiError) return { error: describeApiError(error) };
    return { error: error instanceof Error ? error.message : 'Could not create this customer.' };
  }

  redirect(`/customers?brandId=${brandId}&created=${created.id}`);
}
