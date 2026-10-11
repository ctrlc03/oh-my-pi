/**
 * Excalidraw's stylesheet for the dev server, which serves no `excalidraw-assets/` folder (it answers every
 * unknown path with the app's HTML). Reached only from lib/excalidraw-load.ts and only when not built: the
 * build copies the stylesheet next to the bundle instead and this module never enters it.
 */
import "@excalidraw/excalidraw/index.css";
