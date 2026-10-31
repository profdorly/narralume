import { Component, type ReactNode } from "react";

/* Catches a failed lazy import (for example after an update rebuilt the app
   while this tab stayed open, so the old chunk no longer exists) and renders
   the fallback instead of unmounting the whole interface. */
export class ChunkBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
