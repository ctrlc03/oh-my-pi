/**
 * Entry of the exported page: renders the embedded map with the same viewer the app uses. Built on its own
 * (scripts/build-architecture-standalone.ts) so the main bundle never carries it; the app inlines the result
 * into each exported file. Reads its data from the page, writes the current diagram to the URL hash, and needs
 * no network.
 */
import { Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/tokens.css";
import "../../styles/base.css";
import "./architecture.css";
import type { MapSource } from "./DetailPanel";
import { MapViewer } from "./MapViewer";
import type { ExportPayload } from "./blueprint-export";
import { PAYLOAD_ELEMENT_ID, parsePayload, sourceFromPayload } from "./blueprint-export";
import type { MapLocation } from "./blueprint-model";
import { formatLocationHash, parseLocationHash, rootDiagram } from "./blueprint-model";

const THEME_KEY = "omp-architecture-theme";

function currentTheme(): "light" | "dark" {
	const set = document.documentElement.dataset.theme;
	if (set === "light" || set === "dark") return set;
	return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function ThemeToggle(): ReactNode {
	const [theme, setTheme] = useState(currentTheme);
	const toggle = (): void => {
		const next = theme === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			// A file page may have no storage: the choice then lasts until it is closed.
		}
		setTheme(next);
	};
	return (
		<button
			type="button"
			className="ar-btn ar-btn-icon"
			onClick={toggle}
			aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
		>
			{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
		</button>
	);
}

function Standalone({ payload }: { payload: ExportPayload }): ReactNode {
	const { map } = payload;
	const rootId = rootDiagram(map)?.id ?? "";
	const [location, setLocation] = useState<MapLocation>(
		() => parseLocationHash(window.location.hash) ?? { diagram: rootId },
	);
	useEffect(() => {
		document.title = `${map.title} · architecture map`;
		const onHash = (): void => setLocation(parseLocationHash(window.location.hash) ?? { diagram: rootId });
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, [map.title, rootId]);
	const move = useCallback((next: MapLocation, push: boolean): void => {
		setLocation(next);
		const hash = formatLocationHash(next);
		if (push) history.pushState(null, "", hash);
		else history.replaceState(null, "", hash);
	}, []);
	const source = useMemo<MapSource>(() => sourceFromPayload(payload), [payload]);
	return (
		<MapViewer
			map={map}
			source={source}
			location={location}
			onLocation={move}
			editor={null}
			actions={<ThemeToggle />}
		/>
	);
}

function start(): void {
	const root = document.getElementById("root");
	const data = document.getElementById(PAYLOAD_ELEMENT_ID);
	if (root === null) return;
	try {
		if (data?.textContent == null) throw new Error("The map data is missing from this page.");
		createRoot(root).render(<Standalone payload={parsePayload(data.textContent)} />);
	} catch (error) {
		root.textContent = error instanceof Error ? error.message : String(error);
		root.className = "ar-fatal";
	}
}

start();
