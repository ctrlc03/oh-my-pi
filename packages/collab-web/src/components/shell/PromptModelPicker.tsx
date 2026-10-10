import type { WireModel } from "@oh-my-pi/pi-wire";
import { Replace } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import type { PromptModelChoice } from "../../lib/client";
import { ModelList } from "./ModelControls";
import { Sheet } from "./Sheet";

export interface PromptModelPickerProps {
	models: readonly WireModel[];
	/** The session's model: what a message runs on without a choice. */
	sessionModel: WireModel | undefined;
	/** Set until the next message is sent. */
	choice: PromptModelChoice | null;
	onChoice(choice: PromptModelChoice | null): void;
	disabled: boolean;
}

/** The model a choice names, when the host still offers it. */
export function modelOfChoice(models: readonly WireModel[], choice: PromptModelChoice | null): WireModel | undefined {
	if (choice === null) return undefined;
	return models.find(model => `${model.provider}/${model.id}` === choice.model);
}

/** Composer pill that picks a model (and thinking level) for the next message only; the session's own model stays. */
export function PromptModelPicker({
	models,
	sessionModel,
	choice,
	onChoice,
	disabled,
}: PromptModelPickerProps): ReactNode {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const close = useCallback(() => setAnchor(null), []);
	const chosen = modelOfChoice(models, choice);
	const levels = chosen?.thinkingLevels ?? [];
	const label = chosen ? `${chosen.name}${choice?.thinking ? ` · ${choice.thinking}` : ""}` : null;

	return (
		<>
			<button
				type="button"
				className={label ? "sh-pill sh-pill-once" : "sh-pill sh-pill-icon"}
				onClick={(e: MouseEvent<HTMLButtonElement>) => setAnchor(e.currentTarget.getBoundingClientRect())}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={anchor !== null}
				aria-label={label ? `next message runs on ${label}` : "pick a model for the next message only"}
				title={label ? `next message only: ${label}` : "pick a model for the next message only"}
			>
				<Replace size={13} aria-hidden />
				{label && <span className="sh-pill-text">{label}</span>}
			</button>
			{anchor !== null && (
				<Sheet label="model for the next message" anchor={anchor} onClose={close}>
					<div className="sh-model-list" role="group" aria-label="model for the next message">
						<div className="sh-model-provider">Next message only</div>
						<button
							type="button"
							className={chosen ? "sh-model" : "sh-model sh-model-on"}
							onClick={() => {
								onChoice(null);
								close();
							}}
						>
							<span>Session model</span>
							<span className="sh-sheet-faint">{sessionModel?.name ?? ""}</span>
						</button>
					</div>
					{chosen && levels.length > 0 && (
						<div className="sh-model-list" role="radiogroup" aria-label="thinking level for the next message">
							<div className="sh-model-provider">Thinking</div>
							{[undefined, ...levels].map(level => {
								const on = choice?.thinking === level;
								return (
									<button
										key={level ?? "session"}
										type="button"
										role="radio"
										aria-checked={on}
										className={on ? "sh-model sh-model-on" : "sh-model"}
										onClick={() => choice && onChoice({ ...choice, thinking: level })}
									>
										{level ?? "session default"}
									</button>
								);
							})}
						</div>
					)}
					<ModelList models={models} current={chosen} onChange={spec => onChoice({ model: spec })} />
					<div className="sh-sheet-actions">
						<button type="button" className="sh-btn" onClick={close}>
							Done
						</button>
					</div>
				</Sheet>
			)}
		</>
	);
}
