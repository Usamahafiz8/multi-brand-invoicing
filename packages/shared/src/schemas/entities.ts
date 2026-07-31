import { z } from 'zod';
import { ROLES } from '../domain/roles.js';
import { INVOICE_STATUSES } from '../domain/invoice-status.js';
import { PAYMENT_METHODS } from '../money/calculation.js';
import {
  addressSchema,
  basisPointsSchema,
  currencySchema,
  dateRangeSchema,
  decimalAmountStringSchema,
  emailSchema,
  hexColourSchema,
  idSchema,
  paginationSchema,
  phoneSchema,
  quantityStringSchema,
  timezoneSchema,
} from './common.js';

// --- Authentication --------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'password is required').max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** NFR-SEC: length over composition rules. */
export const passwordSchema = z
  .string()
  .min(12, 'use at least 12 characters')
  .max(200, 'passwords are capped at 200 characters');

// --- Brand -----------------------------------------------------------------

export const brandSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(120),
  salesPersonName: z.string().trim().max(160).nullable(),
  phone: phoneSchema.nullable(),
  email: emailSchema.nullable(),
  mailingAddress: addressSchema.nullable(),
  billingAddress: addressSchema.nullable(),
  taxId: z.string().trim().max(64).nullable(),
  currency: currencySchema,
  timezone: timezoneSchema,
  themeColor: hexColourSchema,
});
export type BrandInput = z.infer<typeof brandSchema>;

export const brandSettingsSchema = z.object({
  invoicePrefix: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9-]+$/, 'prefix may contain A–Z, 0–9 and hyphens'),
  paymentTermsDays: z.number().int().min(0).max(365),
  defaultTaxRateBp: basisPointsSchema,
  cardFeeRateBp: basisPointsSchema,
  lateFeeRateBp: basisPointsSchema,
  partialPaymentEnabled: z.boolean(),
  reminderSchedule: z.array(z.number().int()).max(10),
});
export type BrandSettingsInput = z.infer<typeof brandSettingsSchema>;

/** FR-PAY-005: which methods the public payment page offers for this brand.
 * Deliberately separate from brandSettingsSchema above, which has no
 * consumer yet and a pre-existing mismatch against the actual BrandSettings
 * table (defaultTaxRateBp vs. the DB's defaultTaxRateId) — not this change's
 * concern to resolve. */
export const paymentMethodSettingsSchema = z.object({
  cardEnabled: z.boolean(),
  applePayEnabled: z.boolean(),
  googlePayEnabled: z.boolean(),
  achEnabled: z.boolean(),
  checkEnabled: z.boolean(),
});
export type PaymentMethodSettingsInput = z.infer<typeof paymentMethodSettingsSchema>;

// --- Customer --------------------------------------------------------------

export const customerTypeSchema = z.enum(['BUSINESS', 'INDIVIDUAL']);

export const customerSchema = z
  .object({
    type: customerTypeSchema,
    salutation: z.string().trim().max(32).nullable(),
    firstName: z.string().trim().max(120).nullable(),
    lastName: z.string().trim().max(120).nullable(),
    companyName: z.string().trim().max(200).nullable(),
    displayName: z.string().trim().min(1).max(200),
    email: emailSchema.nullable(),
    phone: phoneSchema.nullable(),
    billingAddress: addressSchema.nullable(),
    shippingAddress: addressSchema.nullable(),
  })
  .refine((v) => v.type !== 'BUSINESS' || Boolean(v.companyName), {
    message: 'a business customer needs a company name',
    path: ['companyName'],
  })
  .refine((v) => v.type !== 'INDIVIDUAL' || Boolean(v.firstName || v.lastName), {
    message: 'an individual customer needs a first or last name',
    path: ['firstName'],
  });
export type CustomerInput = z.infer<typeof customerSchema>;

// --- Invoice ---------------------------------------------------------------

export const lineItemSchema = z.object({
  itemName: z.string().trim().min(1, 'every line needs an item name').max(200),
  description: z.string().trim().max(2000).nullable(),
  quantity: quantityStringSchema,
  unitPrice: decimalAmountStringSchema,
  taxExempt: z.boolean().default(false),
});
export type LineItemInput = z.infer<typeof lineItemSchema>;

export const invoiceDraftSchema = z
  .object({
    brandId: idSchema,
    customerId: idSchema,
    invoiceDate: z.coerce.date(),
    dueDate: z.coerce.date(),
    currency: currencySchema,
    lines: z.array(lineItemSchema).min(1, 'an invoice needs at least one line item'),
    taxRateBp: basisPointsSchema,
    cardFeeRateBp: basisPointsSchema,
    notes: z.string().trim().max(4000).nullable(),
    internalNotes: z.string().trim().max(4000).nullable(),
  })
  .refine((v) => v.dueDate >= v.invoiceDate, {
    message: 'the due date cannot precede the invoice date',
    path: ['dueDate'],
  });
export type InvoiceDraftInput = z.infer<typeof invoiceDraftSchema>;

export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const roleSchema = z.enum(ROLES);

/** Invoice list filters — FR-INV list view: date, brand, and status tabs. */
export const invoiceListQuerySchema = paginationSchema.extend({
  brandId: idSchema.optional(),
  customerId: idSchema.optional(),
  status: z.array(invoiceStatusSchema).optional(),
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().trim().max(200).optional(),
  dateRange: dateRangeSchema.optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

export const customerListQuerySchema = paginationSchema.extend({
  brandId: idSchema.optional(),
  hasOutstanding: z.coerce.boolean().optional(),
  search: z.string().trim().max(200).optional(),
  dateRange: dateRangeSchema.optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

// --- Payment ---------------------------------------------------------------

/**
 * The tokenized instrument the customer is paying with.
 *
 * Every variant is a handle minted elsewhere — a hosted-tokenization nonce from
 * the gateway's own iframes, or a wallet's encrypted payload. There is
 * deliberately no field a card number could be placed in: if this schema could
 * carry a PAN, the API would be inside PCI SAQ D and the whole hosted-fields
 * design would be pointless.
 */
export const paymentSourceSchema = z.object({
  kind: z.enum(['NONCE', 'WALLET', 'STORED']),
  // Wallet payloads are encrypted JSON blobs and run to a few kilobytes.
  token: z.string().min(1).max(8192),
  walletProvider: z.enum(['GOOGLE_PAY', 'APPLE_PAY']).optional(),
  expiryMonth: z.number().int().min(1).max(12).optional(),
  expiryYear: z.number().int().min(2020).max(9999).optional(),
  avsZip: z.string().max(20).optional(),
  avsAddress: z.string().max(255).optional(),
  binType: z.enum(['C', 'D']).optional(),
});
export type PaymentSource = z.infer<typeof paymentSourceSchema>;

export const paymentIntentRequestSchema = z.object({
  publicToken: z.string().regex(/^[0-9a-f]{32}$/),
  method: paymentMethodSchema,
  /** Present only when the brand allows partial payment. */
  amount: decimalAmountStringSchema.optional(),
  /** Client-generated, so a double submit collapses to one charge. */
  attemptNonce: z.string().min(8).max(64),
  /** Absent for gateways that mint their own instrument, e.g. FakeGateway. */
  source: paymentSourceSchema.optional(),
});
export type PaymentIntentRequest = z.infer<typeof paymentIntentRequestSchema>;

// --- Dashboard -------------------------------------------------------------

export const dashboardQuerySchema = z.object({
  brandId: idSchema.optional(),
  dateRange: dateRangeSchema.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
