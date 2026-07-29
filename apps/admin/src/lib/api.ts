/**
 * The admin app's connection to the API.
 *
 * Session cookies travel cross-origin, so every request sends credentials. The
 * API is a separate deployment (TDD-001 ADR-002), which is why this is a fetch
 * client rather than a direct database call from a server component.
 */

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

/**
 * Stopgap for FR-AUTH-001: apps/admin has no login flow yet, so there is no
 * session cookie to send. Server Components attach this bearer token instead,
 * matching the fixed session the seed script writes. Delete this the moment
 * real sign-in exists — it must never be set outside local development.
 */
const DEV_BEARER = process.env['DEV_API_BEARER_TOKEN'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { revalidate?: number } = {},
): Promise<T> {
  const { revalidate, ...requestInit } = init;

  const response = await fetch(`${API_URL}${path}`, {
    ...requestInit,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(DEV_BEARER ? { Authorization: `Bearer ${DEV_BEARER}` } : {}),
      ...requestInit.headers,
    },
    // Health and status must never be served from a cache; a stale "ok" is
    // worse than no answer.
    cache: revalidate === undefined ? 'no-store' : undefined,
    ...(revalidate === undefined ? {} : { next: { revalidate } }),
  });

  const text = await response.text();
  const body = text ? safeJson(text) : null;

  if (!response.ok) {
    const message =
      (body as { message?: string } | null)?.message ?? `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message, body);
  }

  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  environment: string;
  adapters: Record<string, string>;
  checks: Array<{
    name: string;
    state: 'up' | 'down' | 'skipped';
    durationMs: number;
    detail?: string;
  }>;
  checkedAt: string;
}

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health');
}

// --- Brands ------------------------------------------------------------------

export interface Brand {
  id: string;
  displayName: string;
  legalName: string;
  themeColor: string;
  currency: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

export function listBrands(): Promise<Brand[]> {
  return apiFetch<Brand[]>('/brands');
}

/** Mirrors createBrandSchema (brandSchema + invoicePrefix) in the API
 * exactly — nullable fields must be sent as `null`, not omitted. */
export interface BrandFormInput {
  legalName: string;
  displayName: string;
  salesPersonName: string | null;
  phone: string | null;
  email: string | null;
  mailingAddress: CustomerAddress | null;
  billingAddress: CustomerAddress | null;
  taxId: string | null;
  currency: string;
  timezone: string;
  themeColor: string;
  invoicePrefix: string;
}

export function createBrand(input: BrandFormInput): Promise<Brand> {
  return apiFetch<Brand>('/brands', { method: 'POST', body: JSON.stringify(input) });
}

// --- Customers (FR-CUS) ------------------------------------------------------

export interface CustomerAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface Customer {
  id: string;
  brandId: string;
  type: 'BUSINESS' | 'INDIVIDUAL';
  salutation: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  billingAddress: CustomerAddress | null;
  shippingAddress: CustomerAddress | null;
  zohoContactId: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export interface CustomerListResponse {
  data: Customer[];
  page: number;
  pageSize: number;
  total: number;
}

export function listCustomers(
  brandId: string,
  params: { search?: string } = {},
): Promise<CustomerListResponse> {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<CustomerListResponse>(`/brands/${brandId}/customers${suffix}`);
}

export function getCustomer(brandId: string, id: string): Promise<Customer> {
  return apiFetch<Customer>(`/brands/${brandId}/customers/${id}`);
}

/** Mirrors customerSchema in packages/shared exactly — nullable fields must be
 * sent as `null`, not omitted; Zod's .nullable() requires the key to be present. */
export interface CustomerFormInput {
  type: 'BUSINESS' | 'INDIVIDUAL';
  salutation: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  billingAddress: CustomerAddress | null;
  shippingAddress: CustomerAddress | null;
}

export function createCustomer(brandId: string, input: CustomerFormInput): Promise<Customer> {
  return apiFetch<Customer>(`/brands/${brandId}/customers`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// --- Invoices (FR-INV) --------------------------------------------------------

export interface LineItem {
  id: string;
  position: number;
  itemName: string;
  description: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  taxExempt: boolean;
}

export interface Invoice {
  id: string;
  brandId: string;
  customerId: string;
  number: string;
  status: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  subtotalMinor: number;
  taxRateBpApplied: number;
  taxMinor: number;
  cardFeeRateBpApplied: number;
  totalMinor: number;
  balanceMinor: number;
  publicToken: string;
  lineItems: LineItem[];
}

export function listInvoices(brandId: string): Promise<Invoice[]> {
  return apiFetch<Invoice[]>(`/brands/${brandId}/invoices`);
}

export interface LineItemFormInput {
  itemName: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxExempt: boolean;
}

/** Mirrors invoiceDraftSchema in packages/shared. brandId travels in the URL,
 * not this payload — the field the schema still requires there is ignored by
 * the service (see InvoicesController). */
export interface InvoiceFormInput {
  brandId: string;
  customerId: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  lines: LineItemFormInput[];
  taxRateBp: number;
  cardFeeRateBp: number;
  notes: string | null;
  internalNotes: string | null;
}

export function createInvoice(brandId: string, input: InvoiceFormInput): Promise<Invoice> {
  return apiFetch<Invoice>(`/brands/${brandId}/invoices`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function issueInvoice(brandId: string, id: string): Promise<Invoice> {
  return apiFetch<Invoice>(`/brands/${brandId}/invoices/${id}/issue`, { method: 'POST' });
}

// --- Payment method settings (FR-PAY-005) -------------------------------------

export interface PaymentMethodSettings {
  cardEnabled: boolean;
  applePayEnabled: boolean;
  googlePayEnabled: boolean;
  achEnabled: boolean;
  checkEnabled: boolean;
}

export function getPaymentMethodSettings(brandId: string): Promise<PaymentMethodSettings> {
  return apiFetch<PaymentMethodSettings>(`/brands/${brandId}/settings/payment-methods`);
}

export function updatePaymentMethodSettings(
  brandId: string,
  input: PaymentMethodSettings,
): Promise<PaymentMethodSettings> {
  return apiFetch<PaymentMethodSettings>(`/brands/${brandId}/settings/payment-methods`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

// --- Zoho integration (FR-ZHO) ------------------------------------------------

export interface ZohoConnectionStatus {
  connected: boolean;
  organizationName: string | null;
  lastSyncAt: string | null;
  lastPulledAt: string | null;
  health: string | null;
}

export function getZohoStatus(brandId: string): Promise<ZohoConnectionStatus> {
  return apiFetch<ZohoConnectionStatus>(`/brands/${brandId}/integrations/zoho/status`);
}

export interface ZohoActivityEntry {
  direction: 'PUSH' | 'PULL';
  objectType: string;
  status: string;
  errorClass: string | null;
  lastError: string | null;
  updatedAt: string;
}

export function getZohoActivity(brandId: string): Promise<ZohoActivityEntry[]> {
  return apiFetch<ZohoActivityEntry[]>(`/brands/${brandId}/integrations/zoho/activity`);
}

export { API_URL };
