/**
 * Design tokens.
 *
 * Carried forward from the prototype's visual system, but extracted from the
 * hex literals that are currently inlined throughout its component tree
 * (TSD-001 §3.4). Brand colour reaches components as a CSS custom property,
 * which is what lets one component set render in any brand's colours without
 * recompilation.
 */

import { assessBrandColour } from './contrast.js';

/**
 * Product palette — fixed, not brand-controlled.
 *
 * Monochrome: the chrome is pure neutral, so the only colour on any screen is
 * the one the brand chose. The prototype's sage tint was doing the opposite —
 * competing with the brand colour on every surface.
 *
 * Status colours stay chromatic on purpose. They are the one place colour
 * carries meaning rather than style: an overdue invoice reading the same grey
 * as a paid one loses information the neutral scale cannot give back.
 */
export const palette = {
  // Surfaces.
  canvas: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceMuted: '#F5F5F5',
  surfaceSunken: '#EBEBEB',

  // Lines.
  border: '#E5E5E5',
  borderStrong: '#A3A3A3',

  // Ink. inkSubtle is the lightest that still clears 4.5:1 on white — anything
  // paler is decoration, not text (NFR-USE-004).
  ink: '#0A0A0A',
  inkStrong: '#171717',
  inkMuted: '#525252',
  inkSubtle: '#737373',
  inkInverse: '#FFFFFF',

  // Status. Also used for invoice state chips.
  success: '#1F8B5C',
  successSurface: '#E6F4ED',
  warning: '#C97A2B',
  warningSurface: '#FBF0DF',
  danger: '#C0473D',
  dangerSurface: '#F9E7E5',
  info: '#3A6FA8',
  infoSurface: '#E7EEF6',
  // Neutral rather than status-coloured: accent is chrome, not meaning.
  accent: '#171717',
  accentSurface: '#F5F5F5',
} as const;

export type PaletteToken = keyof typeof palette;

/**
 * Default brand colours offered in the brand editor's swatch picker. Black
 * leads because it is the product default — a brand that expresses no
 * preference renders as monochrome as the chrome around it, rather than
 * inheriting some arbitrary hue.
 */
export const BRAND_COLOUR_PRESETS = [
  '#0A0A0A',
  '#2D6A6A',
  '#3A6FA8',
  '#C97A2B',
  '#8B4A9C',
  '#1F8B5C',
  '#C0473D',
] as const;

/**
 * What a brand gets when it has expressed no preference. Widened to `string`
 * deliberately — call sites assign it into a brand colour that is about to be
 * replaced by a real one, and the literal type from the `as const` array above
 * would make every one of those a type error.
 */
export const DEFAULT_BRAND_COLOUR: string = BRAND_COLOUR_PRESETS[0];

export const spacing = {
  0: '0px',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
  16: '64px',
} as const;

export const radii = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  full: '9999px',
} as const;

export const typography = {
  fontSans:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontMono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  size: {
    xs: '12px',
    sm: '13px',
    base: '14px',
    md: '16px',
    lg: '18px',
    xl: '22px',
    '2xl': '28px',
  },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

export const shadows = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.06)',
  md: '0 2px 8px rgba(0, 0, 0, 0.08)',
  lg: '0 8px 24px rgba(0, 0, 0, 0.12)',
} as const;

/** Invoice status → palette tokens, so every surface renders a status alike. */
export const statusTone = {
  DRAFT: { fg: 'inkMuted', bg: 'surfaceSunken' },
  SENT: { fg: 'info', bg: 'infoSurface' },
  VIEWED: { fg: 'accent', bg: 'accentSurface' },
  PENDING_PAYMENT: { fg: 'warning', bg: 'warningSurface' },
  PARTIALLY_PAID: { fg: 'warning', bg: 'warningSurface' },
  PAID: { fg: 'success', bg: 'successSurface' },
  CANCELLED: { fg: 'inkSubtle', bg: 'surfaceSunken' },
  OVERDUE: { fg: 'danger', bg: 'dangerSurface' },
} as const satisfies Record<string, { fg: PaletteToken; bg: PaletteToken }>;

/**
 * The CSS custom properties a brand-themed surface needs. Injected into the
 * document for the admin app's active brand and for the public payment page,
 * with the accessible foreground computed rather than assumed.
 */
export function brandThemeVariables(brandColour: string): Record<string, string> {
  const assessment = assessBrandColour(brandColour, {
    surface: palette.surface,
    ink: palette.ink,
  });
  return {
    '--brand': assessment.brandColour,
    '--brand-foreground': assessment.onBrand,
    '--brand-ink': assessment.brandInk,
  };
}

/** The same, serialised for a `style` attribute or a `<style>` block. */
export function brandThemeCss(brandColour: string, selector = ':root'): string {
  const vars = brandThemeVariables(brandColour);
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n}`;
}

/** Product-level custom properties, emitted once per app. */
export function baseThemeVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(palette)) {
    vars[`--color-${kebab(name)}`] = value;
  }
  for (const [name, value] of Object.entries(spacing)) {
    vars[`--space-${name}`] = value;
  }
  for (const [name, value] of Object.entries(radii)) {
    vars[`--radius-${name}`] = value;
  }
  for (const [name, value] of Object.entries(shadows)) {
    vars[`--shadow-${name}`] = value;
  }
  vars['--font-sans'] = typography.fontSans;
  vars['--font-mono'] = typography.fontMono;
  return vars;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
