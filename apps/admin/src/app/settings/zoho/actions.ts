'use server';

import { redirect } from 'next/navigation';
import { ApiError, backfillZoho, pullZoho } from '@/lib/api';

export async function backfillZohoAction(formData: FormData): Promise<void> {
  const brandId = formData.get('brandId');
  if (typeof brandId !== 'string' || !brandId) {
    redirect('/settings/zoho?error=missing_brand');
  }

  let counts;
  try {
    counts = await backfillZoho(brandId);
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Could not queue the backfill.';
    redirect(`/settings/zoho?brandId=${brandId}&error=${encodeURIComponent(message)}`);
  }

  redirect(
    `/settings/zoho?brandId=${brandId}&backfilled=${counts.customers},${counts.invoices},${counts.payments}`,
  );
}

export async function pullZohoAction(formData: FormData): Promise<void> {
  const brandId = formData.get('brandId');
  if (typeof brandId !== 'string' || !brandId) {
    redirect('/settings/zoho?error=missing_brand');
  }

  try {
    await pullZoho(brandId);
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Could not queue the pull.';
    redirect(`/settings/zoho?brandId=${brandId}&error=${encodeURIComponent(message)}`);
  }

  redirect(`/settings/zoho?brandId=${brandId}&pulling=1`);
}
