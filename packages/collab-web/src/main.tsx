import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initAppearance } from "./lib/appearance";
import "./styles/tokens.css";
import "./styles/base.css";

initAppearance();
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
