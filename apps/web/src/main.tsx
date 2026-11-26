// First: copies browser settings saved before the rename, then drops those keys.
import "./lib/storage-migration";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/primitives.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "./app/shell";
import { followSystemTheme } from "./app/theme";
import { getLocale, loadLocale } from "./i18n";

followSystemTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppShell />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// English is a separate chunk: load it before the first paint so an English
// session does not flash Portuguese. If it fails, pt-BR text is shown.
loadLocale(getLocale()).then(render, render);
