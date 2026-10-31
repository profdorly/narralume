import { Component, type ReactNode } from "react";

/** Messages browsers and Vite use when a dynamic import cannot be fetched. */
const CHUNK_LOAD_ERROR =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|ChunkLoadError/i;

/* Catches a failed lazy import (for example after an update rebuilt the app
   while this tab stayed open, so the old chunk no longer exists) and renders
   the fallback instead of unmounting the whole interface. Any other error is
   rethrown, so real bugs stay visible. */
export class ChunkBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { error: unknown }
> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    if (!CHUNK_LOAD_ERROR.test(message)) throw error;
    return this.props.fallback;
  }
}
