/**
 * Validation schemas shared by client and server (TSD-001 §3.5).
 *
 * One Zod definition validates the form in the browser and the payload at the
 * API boundary. There is no second copy to drift.
 */

import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../money/money.js';

export const idSchema = z.string().uuid();

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/** Money arriving over the wire is a decimal string, never a float. */
export const minorAmountSchema = z
  .number()
  .int('amounts must be whole minor units')
  .safe('amount is outside the safe integer range');

export const decimalAmountStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'expected a decimal amount such as "1234.56"');

export const basisPointsSchema = z
  .number()
  .int('rates are whole basis points')
  .min(0, 'a rate cannot be negative')
  .max(100_000, 'a rate above 1000% is almost certainly a mistake');

export const quantityStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'quantity supports up to four decimal places');

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+()\-.\s\d]*$/, 'phone may contain digits and + ( ) - . only');

export const addressSchema = z.object({
  line1: z.string().trim().max(200).nullable(),
  line2: z.string().trim().max(200).nullable(),
  city: z.string().trim().max(120).nullable(),
  region: z.string().trim().max(120).nullable(),
  postalCode: z.string().trim().max(32).nullable(),
  country: z
    .string()
    .trim()
    .length(2, 'country is an ISO 3166-1 alpha-2 code')
    .toUpperCase()
    .nullable(),
});
export type AddressInput = z.infer<typeof addressSchema>;

/** IANA zone. Explicit everywhere; never inferred from the browser (NFR-LOC-002). */
export const timezoneSchema = z.string().trim().min(1).max(64);

export const hexColourSchema = z
  .string()
  .trim()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected a hex colour such as #2D6A6A')
  .transform((value) => (value.startsWith('#') ? value.toUpperCase() : `#${value.toUpperCase()}`));

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('desc');

export const dateRangeSchema = z
  .object({
    from: z.coerce.date().nullable().default(null),
    to: z.coerce.date().nullable().default(null),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'the start of a date range must not be after its end',
    path: ['from'],
  });

/** 128-bit random token that identifies a public invoice page (NFR-SEC-014). */
export const publicTokenSchema = z.string().regex(/^[0-9a-f]{32}$/, 'malformed invoice token');
