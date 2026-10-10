import type { SessionCommand, WireModel } from "@oh-my-pi/pi-wire";
import { Brain, ChevronDown } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import { fmtTokens } from "../../lib/format";
import { Sheet } from "./Sheet";

/** Models grouped by provider, in the host's order. */
function groupByProvider(models: readonly WireModel[]): [string, WireModel[]][] {
	const groups = new Map<string, WireModel[]>();
	for (const model of models) {
		const group = groups.get(model.provider);
		if (group) group.push(model);
		else groups.set(model.provider, [model]);
	}
	return [...groups];
}

export interface ModelListProps {
	models: readonly WireModel[];
	current: WireModel | undefined;
	/** `provider/id` of the picked model; called only when it differs from `current`. */
	onChange(spec: string): void;
	/** Any pick, current or not: the caller closes its picker. */
	onDone(): void;
}

/** Every model the host offers, providers as headings, one tappable row per model. */
export function ModelList({ models, current, onChange, onDone }: ModelListProps): ReactNode {
	return (
		<div className="sh-model-list" role="listbox" aria-label="model">
			{groupByProvider(models).map(([provider, group]) => (
				<div key={provider} className="sh-model-group">
					<div className="sh-model-provider">{provider}</div>
					{group.map(model => {
						const on = model.id === current?.id && model.provider === current.provider;
						return (
							<button
								key={model.id}
								type="button"
								role="option"
								aria-selected={on}
								className={on ? "sh-model sh-model-on" : "sh-model"}
								onClick={() => {
									onDone();
									if (!on) onChange(`${model.provider}/${model.id}`);
								}}
							>
								<span>{model.name}</span>
								{model.contextWindow !== null && (
									<span className="sh-sheet-faint">{fmtTokens(model.contextWindow)}</span>
								)}
							</button>
						);
					})}
				</div>
			))}
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
}

interface OpenMenu {
	kind: "model" | "thinking";
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
				className="sh-pill"
				onClick={open("model")}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={menu?.kind === "model"}
				title="switch model"
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
					title="thinking level"
				>
					<Brain size={13} aria-hidden />
					<span className="sh-pill-text">{level}</span>
				</button>
			)}
			{menu?.kind === "model" && (
				<Sheet label="model" anchor={menu.anchor} onClose={close}>
					<ModelList
						models={models}
						current={model}
						onChange={spec => onSessionCommand("model", spec)}
						onDone={close}
					/>
				</Sheet>
			)}
			{menu?.kind === "thinking" && thinkingLevels !== undefined && (
				<Sheet label="thinking level" anchor={menu.anchor} onClose={close}>
					<div className="sh-model-list" role="radiogroup" aria-label="thinking level">
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
		</div>
	);
}
