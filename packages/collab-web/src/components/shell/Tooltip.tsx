import { useEffect, useRef } from "react";
import { IS_MAC } from "../../lib/shortcuts";
import { formatKeyshortcuts, placeTip, resolveTipText, TIP_TARGET } from "../../lib/tooltip";
import "./tooltip.css";

/** Mouse and pen: how long a hover rests before the tip shows, and how long after one closes the next shows at once. */
const HOVER_DELAY_MS = 350;
const WARM_MS = 500;
/** Touch: how long a press is held before the tip shows, how long it stays after release, how far a finger may drift. */
const HOLD_MS = 450;
const LINGER_MS = 1500;
const SLOP_PX = 8;
/** Attributes the layer keeps its state in. */
const MOVED = "data-tip-from-title";
const NAMED = "data-tip-names";

interface Tip {
	text: string;
	shortcut: string | null;
}

/**
 * What `el` says in a tooltip. A `title` is taken over (moved into `data-tip`, so the browser's own tooltip
 * never doubles up) and, when it was the control's only name, kept as its `aria-label`. React sets `title`
 * again only when its prop changes, and that fresh value wins over the one taken earlier.
 */
function readTip(el: HTMLElement): Tip | null {
	const title = el.getAttribute("title");
	if (title !== null) {
		if (!el.hasAttribute("data-tip") || el.hasAttribute(MOVED)) {
			el.setAttribute("data-tip", title);
			el.setAttribute(MOVED, "");
			const unnamed = !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby");
			if ((unnamed || el.hasAttribute(NAMED)) && (el.textContent ?? "").trim() === "") {
				el.setAttribute("aria-label", title);
				el.setAttribute(NAMED, "");
			}
		}
		el.removeAttribute("title");
	}
	const text = resolveTipText({
		dataTip: el.getAttribute("data-tip"),
		title: null,
		ariaLabel: el.getAttribute("aria-label"),
		text: el.textContent ?? "",
	});
	if (text === null) return null;
	// A phone has no keyboard to press them on.
	if (!window.matchMedia("(any-hover: hover)").matches) return { text, shortcut: null };
	const own = el.getAttribute("data-shortcut");
	const keys = el.getAttribute("aria-keyshortcuts");
	return { text, shortcut: own ?? (keys === null ? null : formatKeyshortcuts(keys, IS_MAC)) };
}

function targetOf(node: EventTarget | null): HTMLElement | null {
	if (!(node instanceof Element)) return null;
	const el = node.closest<HTMLElement>(TIP_TARGET);
	// Excalidraw's canvas chrome brings its own tooltips.
	return el === null || el.closest(".excalidraw") !== null ? null : el;
}

function focusVisible(el: HTMLElement): boolean {
	try {
		return el.matches(":focus-visible");
	} catch {
		return false;
	}
}

/** Where fixed-position things must not go: the notch, the home indicator, the rounded corners. */
function readInsets(probe: HTMLElement) {
	const style = getComputedStyle(probe);
	return {
		top: Number.parseFloat(style.paddingTop) || 0,
		right: Number.parseFloat(style.paddingRight) || 0,
		bottom: Number.parseFloat(style.paddingBottom) || 0,
		left: Number.parseFloat(style.paddingLeft) || 0,
	};
}

/**
 * The app's one tooltip: a delegated layer over every control, so an icon says what it does on hover, on
 * keyboard focus, and on a touch press-and-hold. Mounted once at the root; Sheets and overlays are covered
 * because the listeners sit on the document.
 */
export function Tooltip() {
	const tipRef = useRef<HTMLDivElement>(null);
	const textRef = useRef<HTMLSpanElement>(null);
	const keyRef = useRef<HTMLElement>(null);
	const probeRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const tip = tipRef.current;
		const text = textRef.current;
		const key = keyRef.current;
		const probe = probeRef.current;
		if (tip === null || text === null || key === null || probe === null) return;

		let current: HTMLElement | null = null;
		let showTimer: number | undefined;
		let hideTimer: number | undefined;
		let pressTimer: number | undefined;
		let closedAt = Number.NEGATIVE_INFINITY;
		let press: { x: number; y: number } | null = null;
		/** The control a long press showed the tip for, until the click its release may send has been swallowed. */
		let held: HTMLElement | null = null;
		let observer: MutationObserver | null = null;
		/** The control whose hover delay is running. */
		let pending: HTMLElement | null = null;

		const hide = (): void => {
			pending = null;
			window.clearTimeout(showTimer);
			window.clearTimeout(hideTimer);
			observer?.disconnect();
			observer = null;
			if (current === null) return;
			current = null;
			closedAt = performance.now();
			tip.removeAttribute("data-open");
		};

		const show = (el: HTMLElement, content: Tip): void => {
			pending = null;
			window.clearTimeout(showTimer);
			window.clearTimeout(hideTimer);
			current = el;
			text.textContent = content.text;
			key.textContent = content.shortcut ?? "";
			key.hidden = content.shortcut === null;
			const rect = el.getBoundingClientRect();
			const place = placeTip(
				rect,
				{ width: tip.offsetWidth, height: tip.offsetHeight },
				{ width: window.innerWidth, height: window.innerHeight },
				readInsets(probe),
			);
			tip.style.left = `${place.left}px`;
			tip.style.top = `${place.top}px`;
			tip.style.setProperty("--tip-arrow", `${place.arrow}px`);
			tip.dataset.side = place.side;
			tip.dataset.open = "";
			observer?.disconnect();
			observer = new MutationObserver(() => {
				if (current !== null && !current.isConnected) hide();
			});
			observer.observe(document.body, { childList: true, subtree: true });
		};

		const onOver = (e: PointerEvent): void => {
			if (e.pointerType === "touch") return;
			const el = targetOf(e.target);
			if (el === null || el === current || el === pending) return;
			const content = readTip(el);
			if (content === null) return;
			window.clearTimeout(showTimer);
			pending = el;
			if (current !== null || performance.now() - closedAt < WARM_MS) show(el, content);
			else showTimer = window.setTimeout(() => show(el, content), HOVER_DELAY_MS);
		};

		const onOut = (e: PointerEvent): void => {
			if (e.pointerType === "touch") return;
			const el = targetOf(e.target);
			if (el === null || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
			window.clearTimeout(showTimer);
			hide();
		};

		const onFocusIn = (e: FocusEvent): void => {
			const el = targetOf(e.target);
			if (el === null || !focusVisible(el)) return;
			const content = readTip(el);
			if (content === null) return;
			// Focus may scroll the control into view; that frame's scroll event would hide the tip, so show after it, in place.
			window.requestAnimationFrame(() => {
				if (el.isConnected && document.activeElement === el) show(el, content);
			});
		};

		const onFocusOut = (e: FocusEvent): void => {
			if (current !== null && targetOf(e.target) === current) hide();
		};

		const onDown = (e: PointerEvent): void => {
			window.clearTimeout(pressTimer);
			held = null;
			hide();
			if (e.pointerType !== "touch" || !e.isPrimary || !(e.target instanceof Element)) return;
			// Holding in a field is the keyboard's loupe and selection handles, not a request for a tip; so is
			// holding in text laid out for the OS to select (`data-native-select`), where the callout must stay.
			if (
				e.target.closest(
					'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-native-select]',
				) !== null
			)
				return;
			const el = targetOf(e.target);
			const content = el === null ? null : readTip(el);
			if (el === null || content === null) return;
			press = { x: e.clientX, y: e.clientY };
			pressTimer = window.setTimeout(() => {
				press = null;
				held = el;
				show(el, content);
			}, HOLD_MS);
		};

		const onMove = (e: PointerEvent): void => {
			if (press !== null && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX) {
				window.clearTimeout(pressTimer);
				press = null;
			}
		};

		const onUp = (e: PointerEvent): void => {
			if (e.pointerType !== "touch") return;
			window.clearTimeout(pressTimer);
			press = null;
			if (e.type === "pointercancel") {
				held = null;
				hide();
			} else if (held !== null) hideTimer = window.setTimeout(hide, LINGER_MS);
		};

		/** A long press must not also press the button: its release's click is swallowed. */
		const onClick = (e: MouseEvent): void => {
			if (held === null) return;
			const swallow = e.target instanceof Node && held.contains(e.target);
			held = null;
			if (!swallow) return;
			e.stopImmediatePropagation();
			e.preventDefault();
		};

		const onContextMenu = (e: Event): void => {
			if (held !== null) e.preventDefault();
		};

		const onScroll = (e: Event): void => {
			if (current === null) return;
			if (e.target === document || (e.target instanceof Node && e.target.contains(current))) hide();
		};

		const onKey = (e: KeyboardEvent): void => {
			// Not `preventDefault`ed: the Sheet under the tip closes on the same press.
			if (e.key === "Escape") hide();
		};

		document.addEventListener("pointerover", onOver);
		document.addEventListener("pointerout", onOut);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("pointermove", onMove, true);
		document.addEventListener("pointerup", onUp, true);
		document.addEventListener("pointercancel", onUp, true);
		document.addEventListener("click", onClick, true);
		document.addEventListener("contextmenu", onContextMenu, true);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", hide);
		window.addEventListener("resize", hide);
		return () => {
			hide();
			window.clearTimeout(pressTimer);
			document.removeEventListener("pointerover", onOver);
			document.removeEventListener("pointerout", onOut);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("pointermove", onMove, true);
			document.removeEventListener("pointerup", onUp, true);
			document.removeEventListener("pointercancel", onUp, true);
			document.removeEventListener("click", onClick, true);
			document.removeEventListener("contextmenu", onContextMenu, true);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("blur", hide);
			window.removeEventListener("resize", hide);
		};
	}, []);

	return (
		<>
			<div ref={tipRef} className="sh-tip" role="tooltip" aria-hidden="true">
				<span ref={textRef} className="sh-tip-text" />
				<kbd ref={keyRef} className="sh-tip-key" hidden />
				<span className="sh-tip-arrow" />
			</div>
			<div ref={probeRef} className="sh-tip-probe" aria-hidden="true" />
		</>
	);
}
