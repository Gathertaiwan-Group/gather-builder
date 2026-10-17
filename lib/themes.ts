import { z } from "zod";
import { cssColor, cssLength, fontStack } from "./validators";

export const THEME_VARS = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
  "fontHeading",
  "fontBody",
  "radius",
] as const;
export type ThemeVar = (typeof THEME_VARS)[number];
export type ThemeTokens = Record<ThemeVar, string>;

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  tokens: ThemeTokens;
  /** Google Fonts css2 的 family 參數（可選） */
  googleFonts?: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "warm-terroir",
    name: "溫潤風土",
    description: "米白底、陶土橘與墨綠，襯線標題。適合餐飲、手作、在地品牌。",
    tokens: {
      primary: "#b5562f",
      secondary: "#3f5a45",
      background: "#f8f3ea",
      surface: "#fffaf2",
      text: "#2b2622",
      muted: "#7a6e63",
      fontHeading: "'Noto Serif TC', 'Songti TC', serif",
      fontBody: "'Noto Sans TC', 'PingFang TC', sans-serif",
      radius: "14px",
    },
    googleFonts: "Noto+Serif+TC:wght@500;700&family=Noto+Sans+TC:wght@400;500;700",
  },
  {
    id: "minimal-modern",
    name: "極簡現代",
    description: "純白與深墨、單一電光藍點綴，無襯線。適合科技、顧問、專業服務。",
    tokens: {
      primary: "#2445e6",
      secondary: "#111827",
      background: "#ffffff",
      surface: "#f4f5f7",
      text: "#111827",
      muted: "#6b7280",
      fontHeading: "'Noto Sans TC', 'PingFang TC', sans-serif",
      fontBody: "'Noto Sans TC', 'PingFang TC', sans-serif",
      radius: "6px",
    },
    googleFonts: "Noto+Sans+TC:wght@400;500;700",
  },
  {
    id: "ocean-calm",
    name: "海潮靜謐",
    description: "霧藍與沙色、圓潤邊角。適合療癒、健康、教育課程。",
    tokens: {
      primary: "#2f6f8f",
      secondary: "#c99a5b",
      background: "#f2f6f7",
      surface: "#ffffff",
      text: "#1f2d33",
      muted: "#5d7079",
      fontHeading: "'Noto Sans TC', 'PingFang TC', sans-serif",
      fontBody: "'Noto Sans TC', 'PingFang TC', sans-serif",
      radius: "20px",
    },
    googleFonts: "Noto+Sans+TC:wght@400;500;700",
  },
];

export const DEFAULT_PRESET = "warm-terroir";

export const themeOverridesSchema = z
  .object({
    primary: cssColor,
    secondary: cssColor,
    background: cssColor,
    surface: cssColor,
    text: cssColor,
    muted: cssColor,
    fontHeading: fontStack,
    fontBody: fontStack,
    radius: cssLength,
  })
  .partial()
  .strict();

export const themeSchema = z
  .object({
    preset: z.enum(THEME_PRESETS.map((p) => p.id) as [string, ...string[]]),
    overrides: themeOverridesSchema.default({}),
  })
  .strict();

export type Theme = z.infer<typeof themeSchema>;

export function getPreset(id: string): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0]!;
}

export function resolveTheme(theme: Theme | undefined): { tokens: ThemeTokens; preset: ThemePreset } {
  const preset = getPreset(theme?.preset ?? DEFAULT_PRESET);
  return { preset, tokens: { ...preset.tokens, ...(theme?.overrides ?? {}) } as ThemeTokens };
}

/** 轉成 CSS 變數（值都已經過 zod 白名單驗證，不會注入） */
export function themeCssVars(theme: Theme | undefined): Record<string, string> {
  const { tokens } = resolveTheme(theme);
  return {
    "--gb-primary": tokens.primary,
    "--gb-secondary": tokens.secondary,
    "--gb-bg": tokens.background,
    "--gb-surface": tokens.surface,
    "--gb-text": tokens.text,
    "--gb-muted": tokens.muted,
    "--gb-font-heading": tokens.fontHeading,
    "--gb-font-body": tokens.fontBody,
    "--gb-radius": tokens.radius,
  };
}
