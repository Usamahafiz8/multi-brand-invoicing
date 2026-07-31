import { describe, expect, it } from 'vitest';
import { BRAND_COLOUR_PRESETS, palette } from './tokens.js';
import {
  DEFAULT_INK,
  assessBrandColour,
  contrastRatio,
  darkenUntilAccessible,
  foregroundOn,
  parseHex,
  toHex,
} from './contrast.js';

describe('hex parsing', () => {
  it('handles three- and six-digit forms', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('2D6A6A')).toEqual({ r: 45, g: 106, b: 106 });
    expect(toHex({ r: 45, g: 106, b: 106 })).toBe('#2D6A6A');
  });

  it('rejects malformed input', () => {
    expect(() => parseHex('#ggg')).toThrow();
    expect(() => parseHex('#12345')).toThrow();
  });
});

describe('contrast ratio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('DEFAULT_INK', () => {
  // contrast.ts cannot import the palette without a cycle, so it carries its
  // own copy of the ink. This is what stops the two drifting apart.
  it('matches palette.ink', () => {
    expect(DEFAULT_INK).toBe(palette.ink);
  });

  it('clears AA against the canvas and every surface token', () => {
    for (const surface of [palette.canvas, palette.surface, palette.surfaceMuted, palette.surfaceSunken]) {
      expect(contrastRatio(DEFAULT_INK, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the neutral ink scale', () => {
  // inkSubtle is the lightest text token; below 4.5:1 it stops being text.
  it('keeps every ink token legible on white', () => {
    for (const ink of [palette.ink, palette.inkStrong, palette.inkMuted, palette.inkSubtle]) {
      expect(contrastRatio(ink, palette.surface), `${ink} on white`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('foregroundOn', () => {
  it('picks white on a dark brand and ink on a light one', () => {
    expect(foregroundOn('#2D6A6A')).toBe('#FFFFFF');
    expect(foregroundOn('#FFE800')).toBe(DEFAULT_INK);
  });
});

describe('darkenUntilAccessible', () => {
  it('leaves an already-compliant colour alone', () => {
    const result = darkenUntilAccessible(DEFAULT_INK);
    expect(result.hex).toBe(DEFAULT_INK);
    expect(result.achieved).toBe(true);
  });

  it('darkens a bright colour until it clears AA as text on white', () => {
    const result = darkenUntilAccessible('#FFE800');
    expect(result.achieved).toBe(true);
    expect(result.ratio).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.hex, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('assessBrandColour', () => {
  it('passes every shipped preset', () => {
    for (const preset of BRAND_COLOUR_PRESETS) {
      const assessment = assessBrandColour(preset);
      expect(assessment.compliant, `${preset} should be usable`).toBe(true);
      expect(assessment.brandInkRatio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('warns when a bright brand colour is illegible as raw text', () => {
    const assessment = assessBrandColour('#FFE800');
    expect(assessment.rawOnSurfaceRatio).toBeLessThan(4.5);
    expect(assessment.warnings.length).toBeGreaterThan(0);
    // A derived ink is still offered, so the brand remains usable.
    expect(assessment.brandInkRatio).toBeGreaterThanOrEqual(4.5);
  });

  it('always returns a foreground that is one of white or the ink', () => {
    for (const colour of ['#000000', '#FFFFFF', '#808080', '#2D6A6A']) {
      expect(['#FFFFFF', DEFAULT_INK]).toContain(assessBrandColour(colour).onBrand);
    }
  });
});
