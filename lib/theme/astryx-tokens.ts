import {
  createColorScheme,
  createLocalStorage,
  createPreference,
  preferencesScript,
} from '@ui-sdk/core';
import type { AstryxPalette, ThemeMode } from '@/lib/types';

export const ASTRYX_THEME_STORAGE_KEY = 'web-ade:color-scheme';
export const ASTRYX_PALETTE_STORAGE_KEY = 'web-ade:astryx-palette';

export interface AstryxPaletteMeta {
  id: AstryxPalette;
  name: string;
  description: string;
  swatches: {
    lightCanvas: string;
    lightSurface: string;
    lightAccent: string;
    darkCanvas: string;
    darkSurface: string;
    darkAccent: string;
  };
}

export const ASTRYX_PALETTES: readonly AstryxPaletteMeta[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    description: 'Cool slate light canvas, obsidian dark mode, and Astryx cobalt.',
    swatches: {
      lightCanvas: '#F1F4F7',
      lightSurface: '#FFFFFF',
      lightAccent: '#0064E0',
      darkCanvas: '#111112',
      darkSurface: '#1F1F22',
      darkAccent: '#3D87FF',
    },
  },
  {
    id: 'stone',
    name: 'Stone',
    description: 'Warm architectural paper and deep espresso with amber ink.',
    swatches: {
      lightCanvas: '#F4F2EE',
      lightSurface: '#FCFBF9',
      lightAccent: '#B45309',
      darkCanvas: '#141210',
      darkSurface: '#211E1B',
      darkAccent: '#F59E0B',
    },
  },
  {
    id: 'matcha',
    name: 'Matcha',
    description: 'Calm botanical sage and deep forest surfaces with emerald accents.',
    swatches: {
      lightCanvas: '#EFF4F0',
      lightSurface: '#FAFDFB',
      lightAccent: '#157A4B',
      darkCanvas: '#0E1411',
      darkSurface: '#18221D',
      darkAccent: '#34D399',
    },
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'High-contrast monochrome studio with crisp indigo highlights.',
    swatches: {
      lightCanvas: '#EEF0F4',
      lightSurface: '#FAFAFC',
      lightAccent: '#4F46E5',
      darkCanvas: '#09090B',
      darkSurface: '#141418',
      darkAccent: '#818CF8',
    },
  },
] as const;

export const ASTRYX_PALETTE_IDS = ['neutral', 'stone', 'matcha', 'obsidian'] as const;
export const THEME_MODES = ['system', 'light', 'dark'] as const;

export const ASTRYX_RADII = {
  inner: '8px',
  element: '12px',
  container: '16px',
  chat: '28px',
  page: '32px',
  full: '9999px',
} as const;

export const ASTRYX_MOTION = {
  fastMs: 125,
  mediumMs: 300,
  slowMs: 700,
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
  easeEntrance: 'cubic-bezier(0, 0, 0.2, 1)',
  easeMove: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/**
 * Shared `@ui-sdk/core` preferences for color scheme and Astryx palette.
 * Synchronizes `data-color-scheme` and `data-astryx-theme` on `<html>` with zero-flash SSR bootstrap.
 */
export const adeColorScheme = createColorScheme({
  defaultValue: 'system',
  global: true,
  storage: createLocalStorage(ASTRYX_THEME_STORAGE_KEY),
});

export const adePalettePreference = createPreference<AstryxPalette>({
  values: ASTRYX_PALETTE_IDS,
  defaultValue: 'neutral',
  attribute: 'data-astryx-theme',
  global: true,
  storage: createLocalStorage(ASTRYX_PALETTE_STORAGE_KEY),
});

export const ADE_PREFERENCES = [adeColorScheme, adePalettePreference] as const;

export function isAstryxPalette(value: unknown): value is AstryxPalette {
  return typeof value === 'string' && (ASTRYX_PALETTE_IDS as readonly string[]).includes(value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * Apply both `color-scheme` CSS property and `data-color-scheme` / `data-astryx-theme`
 * attributes onto `<html>` immediately without triggering React re-renders.
 */
export function applyThemeToDocument(theme: ThemeMode, palette?: AstryxPalette): void {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.setAttribute('data-color-scheme', theme);

  if (theme === 'system') {
    root.style.colorScheme = 'light dark';
    const isDark =
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
  } else {
    root.style.colorScheme = theme;
    root.classList.toggle('dark', theme === 'dark');
  }

  if (palette && isAstryxPalette(palette)) {
    root.setAttribute('data-astryx-theme', palette);
  }
}

export function setThemeMode(theme: ThemeMode): void {
  adeColorScheme.set(theme);
  applyThemeToDocument(theme);
}

export function setAstryxPalette(palette: AstryxPalette): void {
  adePalettePreference.set(palette);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-astryx-theme', palette);
  }
}

export function readStoredThemeMode(): ThemeMode {
  const current = adeColorScheme.get().value;
  if (isThemeMode(current)) {
    return current;
  }
  return 'system';
}

export function readStoredAstryxPalette(): AstryxPalette {
  const current = adePalettePreference.get().value;
  if (isAstryxPalette(current)) {
    return current;
  }
  return 'neutral';
}

/**
 * Zero-flash inline bootstrap script executed in `<head>` before hydration.
 * Uses `@ui-sdk/core` `preferencesScript` and pairs it with native CSS `color-scheme`
 * + `.dark` class sync (including system media query reactivity).
 */
export function getAstryxBootstrapScript(): string {
  const uiSdkScript = preferencesScript(ADE_PREFERENCES);
  return `(function(){try{${uiSdkScript};var r=document.documentElement;var s=r.getAttribute('data-color-scheme')||'system';var p=r.getAttribute('data-astryx-theme')||'neutral';if(['neutral','stone','matcha','obsidian'].indexOf(p)===-1){p='neutral';r.setAttribute('data-astryx-theme',p);}var mq=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');function sync(mode){var resolved=mode==='system'?(mq&&mq.matches?'dark':'light'):mode;r.style.colorScheme=mode==='system'?'light dark':mode;r.classList.toggle('dark',resolved==='dark');}sync(s);if(mq&&mq.addEventListener){mq.addEventListener('change',function(){if((r.getAttribute('data-color-scheme')||'system')==='system'){sync('system');}});}}catch(e){}})();`;
}
