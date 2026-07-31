import { describe, expect, it } from 'vitest';
import { brandSettingsSchema } from '../schemas/entities.js';
import { FALLBACK_INVOICE_PREFIX, deriveInvoicePrefix } from './invoice-prefix.js';

const prefixSchema = brandSettingsSchema.shape.invoicePrefix;

describe('deriveInvoicePrefix', () => {
  it('takes the initials of a multi-word name', () => {
    expect(deriveInvoicePrefix('Prime Shelf Space')).toBe('PSS');
  });

  it('ignores the legal suffix', () => {
    expect(deriveInvoicePrefix('Prime Shelf Space Inc.')).toBe('PSS');
    expect(deriveInvoicePrefix('Solstice Trading LLC')).toBe('ST');
    expect(deriveInvoicePrefix('Cobalt Studio Supply Ltd')).toBe('CSS');
  });

  it('opens out a single-word name rather than returning one letter', () => {
    expect(deriveInvoicePrefix('Meridian')).toBe('MERI');
  });

  it('treats punctuation as a word boundary instead of carrying it through', () => {
    expect(deriveInvoicePrefix('Smith & Sons')).toBe('SS');
    expect(deriveInvoicePrefix("O'Brien Supply")).toBe('OS');
  });

  it('falls back when nothing in the Latin range survives', () => {
    expect(deriveInvoicePrefix('株式会社')).toBe(FALLBACK_INVOICE_PREFIX);
    expect(deriveInvoicePrefix('   ')).toBe(FALLBACK_INVOICE_PREFIX);
  });

  it('falls back to the whole name when every word is a noise word', () => {
    // "The Company" is all suffix — the filter must not leave nothing behind.
    expect(deriveInvoicePrefix('The Company')).toBe('TC');
  });

  // The point of the whole function: whatever it returns has to be storable.
  it('always produces something brandSettingsSchema accepts', () => {
    const names = [
      'Prime Shelf Space Inc.',
      'Meridian',
      'Smith & Sons',
      "O'Brien Supply",
      '株式会社',
      '   ',
      'A',
      '123 Industries',
      'X Y Z Q R S T U V W',
      'Ünïcødé Bränd',
      '!!!',
      'the and of',
    ];
    for (const name of names) {
      expect(prefixSchema.safeParse(deriveInvoicePrefix(name)).success, name).toBe(true);
    }
  });
});
