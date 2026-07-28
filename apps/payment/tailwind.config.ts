import type { Config } from 'tailwindcss';
import { tailwindPreset } from '@fenwick/shared/tokens';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [tailwindPreset as unknown as Config],
} satisfies Config;
