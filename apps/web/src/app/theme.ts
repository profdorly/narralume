import { create } from "zustand";

/* Follows the system by default; the user can temporarily flip day/night, and
   clicking again restores following the system. */

type Theme = "light" | "dark";
type ThemePreference = "system" | Theme;

const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
const THEME_PREFERENCE_KEY = "lapis:theme-preference";

function themeFor(matchesDark: boolean): Theme {
  return matchesDark ? "dark" : "light";
}

function systemTheme(): Theme {
  if (typeof window.matchMedia !== "function") return "light";
  return themeFor(window.matchMedia(SYSTEM_THEME_QUERY).matches);
}

function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function resolvedTheme(preference: ThemePreference): Theme {
  return preference === "system" ? systemTheme() : preference;
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  preference: ThemePreference;
  theme: Theme;
  toggleTheme: () => void;
}

const initialPreference = readPreference();

export const useTheme = create<ThemeState>()((set, get) => ({
  preference: initialPreference,
  theme: resolvedTheme(initialPreference),
  toggleTheme: () => {
    const current = get();
    const preference: ThemePreference =
      current.preference === "system"
        ? current.theme === "light"
          ? "dark"
          : "light"
        : "system";
    try {
      if (preference === "system") {
        window.localStorage.removeItem(THEME_PREFERENCE_KEY);
      } else {
        window.localStorage.setItem(THEME_PREFERENCE_KEY, preference);
      }
    } catch {
      /* In private browsing, keep only the current session. */
    }
    const theme = resolvedTheme(preference);
    applyTheme(theme);
    set({ preference, theme });
  },
}));

export function followSystemTheme(): () => void {
  if (typeof window.matchMedia !== "function") {
    const preference = readPreference();
    const theme = preference === "system" ? "light" : preference;
    applyTheme(theme);
    useTheme.setState({ preference, theme });
    return () => undefined;
  }

  const media = window.matchMedia(SYSTEM_THEME_QUERY);
  const sync = (event?: MediaQueryListEvent) => {
    // A saved choice wins over the system; it still has to be applied at startup.
    const preference = useTheme.getState().preference;
    const theme =
      preference === "system"
        ? themeFor(event?.matches ?? media.matches)
        : preference;
    applyTheme(theme);
    useTheme.setState({ theme });
  };
  sync();
  media.addEventListener("change", sync);
  return () => media.removeEventListener("change", sync);
}
