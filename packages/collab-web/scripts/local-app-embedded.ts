// Always null on disk. A standalone binary build replaces this module in memory with the manifest of the app it
// embeds (scripts/local-app-embed.ts), so the companion in that binary serves the app without a checkout.
import type { EmbeddedApp } from "./local-app";

export const embeddedApp: EmbeddedApp | null = null;
