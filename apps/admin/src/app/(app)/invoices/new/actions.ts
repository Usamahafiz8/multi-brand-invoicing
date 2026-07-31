'use server';

import { redirect } from 'next/navigation';
import { ApiError, createInvoice, issueInvoice, type LineItemFormInput } from '@/lib/api';

export interface CreateInvoiceState {
  readonly error?: string;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** "6" or "2.9" (a percentage) -> basis points, rounded. */
function percentToBp(value: FormDataEntryValue | null): number {
  const percent = Number(typeof value === 'string' ? value : '0');
  if (!Number.isFinite(percent)) return 0;
  return Math.round(percent * 100);
}

function describeApiError(error: ApiError): string {
  const body = error.body as { issues?: Array<{ path: string; message: string }>; message?: string } | null;
  if (body?.issues?.length) {
    return body.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join(' · ');
  }
  return body?.message ?? error.message;
}

/**
 * Creates a draft and immediately issues it — a two-step Save Draft / Issue
 * flow is the eventual FR-INV shape, but a single action gets a payable
 * invoice into existence with the least friction for a first version.
 */
export async function createInvoiceAction(
  _prevState: CreateInvoiceState,
  formData: FormData,
): Promise<CreateInvoiceState> {
  const brandId = emptyToNull(formData.get('brandId'));
  const customerId = emptyToNull(formData.get('customerId'));
  if (!brandId) return { error: 'No brand selected.' };
  if (!customerId) return { error: 'Choose a customer.' };

  const invoiceDate = emptyToNull(formData.get('invoiceDate'));
  const dueDate = emptyToNull(formData.get('dueDate'));
  if (!invoiceDate || !dueDate) return { error: 'Set both an invoice date and a due date.' };
  if (dueDate < invoiceDate) return { error: 'The due date cannot come before the invoice date.' };

  const lineCount = Number(formData.get('lineCount') ?? '0');
  const lines: LineItemFormInput[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const itemName = emptyToNull(formData.get(`lines.${i}.itemName`));
    const quantity = emptyToNull(formData.get(`lines.${i}.quantity`));
    const unitPrice = emptyToNull(formData.get(`lines.${i}.unitPrice`));
    if (!itemName || !quantity || !unitPrice) continue; // a row left blank is skipped, not an error
    lines.push({
      itemName,
      description: emptyToNull(formData.get(`lines.${i}.description`)),
      quantity,
      unitPrice,
      taxExempt: formData.get(`lines.${i}.taxExempt`) === 'on',
    });
  }
  if (lines.length === 0) return { error: 'Add at least one line item.' };

  const input = {
    brandId,
    customerId,
    invoiceDate,
    dueDate,
    currency: 'USD',
    lines,
    taxRateBp: percentToBp(formData.get('taxRatePercent')),
    cardFeeRateBp: percentToBp(formData.get('cardFeeRatePercent')),
    notes: emptyToNull(formData.get('notes')),
    internalNotes: null,
  };

  let created;
  try {
    created = await createInvoice(brandId, input);
  } catch (error) {
    if (error instanceof ApiError) return { error: describeApiError(error) };
    return { error: error instanceof Error ? error.message : 'Could not create this invoice.' };
  }

  try {
    await issueInvoice(brandId, created.id);
  } catch (error) {
    // The draft exists even if issuing failed — send the user to the list
    // rather than losing the created invoice.
    const detail = error instanceof ApiError ? describeApiError(error) : String(error);
    redirect(`/invoices?brandId=${brandId}&issueFailed=${encodeURIComponent(detail)}`);
  }

  redirect(`/invoices?brandId=${brandId}&created=${created.id}`);
}
