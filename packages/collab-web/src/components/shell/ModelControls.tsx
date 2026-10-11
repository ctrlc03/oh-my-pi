import type { SessionCommand, WireModel, WireProfile } from "@oh-my-pi/pi-wire";
import { Brain, ChevronDown, Search, UserCog, X } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtTokens } from "../../lib/format";
import { arrangeModels, MODEL_FILTER_MIN } from "../../lib/model-filter";
import { Sheet } from "./Sheet";

/** Primary input is a finger: the on-screen keyboard would cover the list the moment the filter took focus. */
const isTouch = (): boolean =>
	typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;

export interface ModelListProps {
	models: readonly WireModel[];
	current: WireModel | undefined;
	/** `provider/id` of the picked model; called only when it differs from `current`. */
	onChange(spec: string): void;
	/** Any pick, current or not: the caller closes its picker. Absent keeps the picker open. */
	onDone?(): void;
	/** Focus the filter field on open (not on touch screens). For pickers the user just opened, not ones shown with their sheet. */
	autoFocus?: boolean;
}

/**
 * Every model the host offers, providers as sticky headings with their counts, one tappable row per model. Past
 * `MODEL_FILTER_MIN` models a filter field narrows them; Enter picks the first match, Esc clears the filter before
 * anything closes. The list opens scrolled to the current model.
 */
export function ModelList({ models, current, onChange, onDone, autoFocus = false }: ModelListProps): ReactNode {
	const [query, setQuery] = useState("");
	const filterable = models.length > MODEL_FILTER_MIN;
	const groups = useMemo(
		() => arrangeModels(models, current, filterable ? query : ""),
		[models, current, filterable, query],
	);
	const listId = useId();
	const list = useRef<HTMLDivElement>(null);
	const filter = useRef<HTMLInputElement>(null);

	// Open on the current model, centred. Only the list scrolls: scrollIntoView would also move the sheet around it.
	useLayoutEffect(() => {
		const box = list.current;
		const row = box?.querySelector<HTMLElement>("[aria-selected='true']");
		if (box && row) box.scrollTop = row.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
	}, []);

	useEffect(() => {
		if (autoFocus && filterable && !isTouch()) filter.current?.focus({ preventScroll: true });
	}, [autoFocus, filterable]);

	const pick = (model: WireModel): void => {
		onDone?.();
		if (model.id !== current?.id || model.provider !== current.provider) onChange(`${model.provider}/${model.id}`);
	};

	const setFilter = (next: string): void => {
		setQuery(next);
		if (list.current) list.current.scrollTop = 0;
	};

	const rows = (): HTMLElement[] => [...(list.current?.querySelectorAll<HTMLElement>(".sh-model") ?? [])];

	const onFilterKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.nativeEvent.isComposing) return;
		if (e.key === "Escape" && query !== "") {
			// Clears the filter; the sheet only closes on an Escape nothing handled.
			e.preventDefault();
			setFilter("");
		} else if (e.key === "Enter") {
			e.preventDefault();
			const first = groups[0]?.models[0];
			if (first) pick(first);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			rows()[0]?.focus();
		}
	};

	const onRowKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const all = rows();
		const at = all.indexOf(e.target as HTMLElement);
		if (at < 0) return;
		e.preventDefault();
		if (e.key === "ArrowUp" && at === 0) filter.current?.focus();
		else all[Math.min(all.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
	};

	return (
		<div className="sh-model-picker">
			{filterable && (
				<div className="sh-model-filter">
					<Search size={15} className="sh-model-filter-icon" aria-hidden />
					<input
						ref={filter}
						className="sh-input sh-model-filter-input"
						type="text"
						value={query}
						onChange={e => setFilter(e.target.value)}
						onKeyDown={onFilterKey}
						placeholder="Filter models"
						aria-label="Filter models"
						aria-controls={listId}
						enterKeyHint="go"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
					/>
					{query !== "" && (
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-model-filter-clear"
							onClick={() => {
								setFilter("");
								filter.current?.focus();
							}}
							aria-label="Clear filter"
							title="Clear filter"
						>
							<X size={14} />
						</button>
					)}
				</div>
			)}
			<div
				ref={list}
				id={listId}
				className="sh-model-list sh-model-picker-list"
				role="listbox"
				aria-label="Model"
				onKeyDown={onRowKey}
			>
				{groups.map(({ provider, models: group }) => (
					<div key={provider} className="sh-model-group">
						<div className="sh-model-provider">
							<span>{provider}</span>
							<span className="sh-model-count">{group.length}</span>
						</div>
						{group.map(model => {
							const on = model.id === current?.id && model.provider === current.provider;
							const first = query !== "" && model === groups[0]?.models[0];
							return (
								<button
									key={model.id}
									type="button"
									role="option"
									aria-selected={on}
									className={`sh-model${on ? " sh-model-on" : ""}${first ? " sh-model-first" : ""}`}
									title={model.id}
									onClick={() => pick(model)}
								>
									<span className="sh-model-name">{model.name}</span>
									{model.contextWindow !== null && (
										<span className="sh-sheet-faint">{fmtTokens(model.contextWindow)}</span>
									)}
								</button>
							);
						})}
					</div>
				))}
				{filterable && groups.length === 0 && (
					<div className="sh-model-empty" role="status">
						No models match
					</div>
				)}
			</div>
		</div>
	);
}

export interface ModelControlsProps {
	/** Models this writer may switch to. */
	models: readonly WireModel[];
	model: WireModel | undefined;
	thinkingLevel: string | undefined;
	/** Levels the current model accepts; empty or absent hides the thinking pill. */
	thinkingLevels: readonly string[] | undefined;
	disabled: boolean;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
	/** Profiles the host offers; null or empty (host without `profiles`, view-only guest) hides the profile pill. */
	profiles?: readonly WireProfile[] | null;
	/** Name of the active profile. */
	profile?: string;
	/** Extra pills after the thinking pill. */
	children?: ReactNode;
}

interface OpenMenu {
	kind: "model" | "thinking" | "profile";
	/** The pill that opened it: the menu opens upward from there. */
	anchor: DOMRect;
}

/** Model and thinking-level pills for the composer toolbar, each opening a picker above it. */
export function ModelControls({
	models,
	model,
	thinkingLevel,
	thinkingLevels,
	disabled,
	onSessionCommand,
	children,
	profiles,
	profile,
}: ModelControlsProps): ReactNode {
	const [menu, setMenu] = useState<OpenMenu | null>(null);
	const close = useCallback(() => setMenu(null), []);
	const open = (kind: OpenMenu["kind"]) => (e: MouseEvent<HTMLButtonElement>) =>
		setMenu({ kind, anchor: e.currentTarget.getBoundingClientRect() });
	const level = thinkingLevel ?? "off";

	return (
		<div className="sh-composer-tools">
			<button
				type="button"
				className="sh-pill sh-pill-model"
				onClick={open("model")}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={menu?.kind === "model"}
				aria-label={`Model: ${model?.name ?? "None selected"}`}
				title={`${model?.name ?? "No model"}: switch model`}
			>
				<span className="sh-pill-text">{model?.name ?? "Model"}</span>
				<ChevronDown size={13} aria-hidden />
			</button>
			{thinkingLevels !== undefined && thinkingLevels.length > 0 && (
				<button
					type="button"
					className="sh-pill"
					onClick={open("thinking")}
					disabled={disabled}
					aria-haspopup="dialog"
					aria-expanded={menu?.kind === "thinking"}
					aria-label={`Thinking level: ${level}`}
					title="Thinking level"
				>
					<Brain size={13} aria-hidden />
					<span className="sh-pill-text">{level}</span>
				</button>
			)}
			{profiles && profiles.length > 0 && (
				<button
					type="button"
					className="sh-pill"
					onClick={open("profile")}
					disabled={disabled}
					aria-haspopup="dialog"
					aria-expanded={menu?.kind === "profile"}
					aria-label={`Profile: ${profile ?? "None"}`}
					title="Switch profile"
				>
					<UserCog size={13} aria-hidden />
					<span className="sh-pill-text">{profile ?? "profile"}</span>
				</button>
			)}
			{menu?.kind === "model" && (
				<Sheet label="model" anchor={menu.anchor} onClose={close}>
					<ModelList
						models={models}
						current={model}
						onChange={spec => onSessionCommand("model", spec)}
						onDone={close}
						autoFocus
					/>
				</Sheet>
			)}
			{menu?.kind === "thinking" && thinkingLevels !== undefined && (
				<Sheet label="thinking level" anchor={menu.anchor} onClose={close}>
					<div className="sh-model-list" role="radiogroup" aria-label="Thinking level">
						<div className="sh-model-provider">Thinking</div>
						{thinkingLevels.map(option => (
							<button
								key={option}
								type="button"
								role="radio"
								aria-checked={option === level}
								className={option === level ? "sh-model sh-model-on" : "sh-model"}
								onClick={() => {
									close();
									if (option !== level) onSessionCommand("thinking", option);
								}}
							>
								{option}
							</button>
						))}
					</div>
				</Sheet>
			)}
			{menu?.kind === "profile" && profiles && (
				<Sheet label="profile" anchor={menu.anchor} onClose={close}>
					<div className="sh-model-list" role="radiogroup" aria-label="Profile">
						<div className="sh-model-provider">Profile</div>
						{profiles.map(option => {
							const on = option.name === profile;
							return (
								<button
									key={option.name}
									type="button"
									role="radio"
									aria-checked={on}
									className={on ? "sh-model sh-model-on" : "sh-model"}
									onClick={() => {
										close();
										if (!on) onSessionCommand("profile", option.name);
									}}
								>
									<span className="sh-profile-text">
										<span>{option.name}</span>
										{option.description && <span className="sh-sheet-faint">{option.description}</span>}
									</span>
								</button>
							);
						})}
					</div>
				</Sheet>
			)}
			{children}
		</div>
	);
}
