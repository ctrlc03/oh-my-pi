import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initAppearance } from "./lib/appearance";
import { installDropGuard } from "./lib/drop";
import "./styles/tokens.css";
import "./styles/base.css";

initAppearance();
installDropGuard(window);
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
