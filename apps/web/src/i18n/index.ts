import { useSyncExternalStore } from "react";

import { ptBrMessages, type Messages } from "./pt-BR";

/* Lightweight i18n: one dictionary per locale plus a module-level locale,
   which React reads through useSyncExternalStore. Both dictionaries have the
   same shape (TypeScript enforces it) and callers use dotted keys.
   pt-BR, the primary language, ships in the main bundle; English loads on
   demand, so most sessions never download it. */

export type Locale = "pt-BR" | "en";

export const LOCALES: readonly Locale[] = ["pt-BR", "en"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  "pt-BR": "Português",
  en: "English",
};

const STORAGE_KEY = "lapis:ui-locale";

const MESSAGES: Partial<Record<Locale, Messages>> = {
  "pt-BR": ptBrMessages,
};

const LOADERS: Record<Locale, () => Promise<Messages>> = {
  "pt-BR": () => Promise.resolve(ptBrMessages),
  en: () => import("./en").then((module) => module.enMessages),
};

const pending = new Map<Locale, Promise<void>>();

type FlattenKeys<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : `${K}.${FlattenKeys<T[K]>}`;
}[keyof T & string];

/** Every valid dictionary key (dotted path), e.g. "common.action.save". */
export type MessageKey = FlattenKeys<Messages>;

type MessageVars = Record<string, string | number>;

function lookup(locale: Locale, key: string): string | null {
  let node: unknown = MESSAGES[locale];
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

const warnedKeys = new Set<string>();

/** "{count, plural, one {# capítulo} other {# capítulos}}": "one" for
 *  exactly 1 (and -1), "other" otherwise, in both languages; "#" prints the
 *  number. Branches hold plain text and "#" only, no nested placeholders. */
const PLURAL = /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g;

/** Callers sometimes pass formatted counts ("1.000", "1,000", "1 000"):
 *  read digit groups as one number, so a thousand is never "one". */
function pluralValue(value: string | number): number {
  if (typeof value === "number") return value;
  const text = value.trim();
  return /^-?\d{1,3}(?:[.,\s\u00a0\u202f]\d{3})+$/u.test(text)
    ? Number(text.replace(/[^\d-]/gu, ""))
    : Number(text);
}

function applyPlurals(template: string, vars: MessageVars): string {
  return template.replace(
    PLURAL,
    (raw, name: string, one: string, other: string) => {
      if (!(name in vars)) return raw;
      const value = vars[name]!;
      const branch = Math.abs(pluralValue(value)) === 1 ? one : other;
      return branch.replace(/#/g, String(value));
    },
  );
}

/**
 * Pure translation function usable outside React; variables are interpolated as
 * {name}.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: MessageVars,
): string {
  const template = lookup(locale, key) ?? lookup("pt-BR", key);
  if (template === null) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[i18n] missing message key: ${key}`);
    }
    return key;
  }
  if (!vars) return template;
  return applyPlurals(template, vars).replace(
    /\{(\w+)\}/g,
    (raw, name: string) => (name in vars ? String(vars[name]) : raw),
  );
}

function detectInitialLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "pt-BR" || saved === "en") return saved;
  } catch {
    /* In private browsing, treat as not stored */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "") ?? "";
  if (nav.toLowerCase().startsWith("en")) return "en";
  return "pt-BR";
}

let currentLocale: Locale = detectInitialLocale();

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

/** Makes a dictionary available to translate(). Tests use it to preload. */
export function registerMessages(locale: Locale, messages: Messages): void {
  MESSAGES[locale] = messages;
}

/** Loads a locale's dictionary once. Until it arrives, translate() falls
 *  back to pt-BR; subscribers re-render when the current locale loads. */
export function loadLocale(locale: Locale): Promise<void> {
  if (MESSAGES[locale]) return Promise.resolve();
  const existing = pending.get(locale);
  if (existing) return existing;
  const loading = LOADERS[locale]().then(
    (messages) => {
      registerMessages(locale, messages);
      pending.delete(locale);
      if (locale === currentLocale) for (const listener of listeners) listener();
    },
    (error: unknown) => {
      pending.delete(locale);
      throw error;
    },
  );
  pending.set(locale, loading);
  return loading;
}

/** Switches the interface language. A dictionary that is not loaded yet is
 *  fetched first, so the switch happens once its text is available. */
export function setLocale(locale: Locale): void {
  if (!MESSAGES[locale]) {
    loadLocale(locale).then(
      () => setLocale(locale),
      (error: unknown) =>
        console.warn(`[i18n] could not load the ${locale} dictionary`, error),
    );
    return;
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* In private browsing, keep only the current session state */
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof document !== "undefined") {
  document.documentElement.lang = currentLocale;
}

interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: MessageVars) => string;
}

/**
 * React entry point: subscribes to locale changes and provides the translation
 * function.
 */
export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribe, getLocale);
  return {
    locale,
    setLocale,
    t: (key, vars) => translate(locale, key, vars),
  };
}
