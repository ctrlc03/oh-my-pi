import { CaseSensitive, Regex, WholeWord } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { type SearchForm } from "./explorer-state";

export interface SearchViewProps {
	form: SearchForm;
	onForm(form: SearchForm): void;
	/** Why the query cannot be searched (an invalid regular expression), else null. */
	invalid: string | null;
	inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The explorer's Search view: the query and its options. The matches are listed in the editor's bottom panel (the
 * Search results tab), which comes forward when a search runs.
 */
export function SearchView({ form, onForm, invalid, inputRef }: SearchViewProps): ReactNode {
	const { query, caseSensitive, wholeWord, regex, glob } = form;
	const toggleOption = (key: "caseSensitive" | "wholeWord" | "regex"): void => onForm({ ...form, [key]: !form[key] });
	return (
		<>
			<div className="sh-ex-search">
				<div className="sh-ex-query">
					<input
						ref={inputRef}
						type="text"
						className="sh-ex-input"
						value={query}
						onChange={event => onForm({ ...form, query: event.target.value })}
						placeholder="Search in files"
						aria-label="Search in files"
						aria-invalid={invalid !== null}
						spellCheck={false}
						autoComplete="off"
						autoCapitalize="off"
					/>
					<Toggle on={caseSensitive} label="Match case" onClick={() => toggleOption("caseSensitive")}>
						<CaseSensitive size={15} />
					</Toggle>
					<Toggle on={wholeWord} label="Match whole word" onClick={() => toggleOption("wholeWord")}>
						<WholeWord size={15} />
					</Toggle>
					<Toggle on={regex} label="Use regular expression" onClick={() => toggleOption("regex")}>
						<Regex size={15} />
					</Toggle>
				</div>
				<input
					type="text"
					className="sh-ex-input sh-ex-glob"
					value={glob}
					onChange={event => onForm({ ...form, glob: event.target.value })}
					placeholder="Files to include, e.g. src/**/*.ts"
					aria-label="Files to include"
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
				/>
			</div>
			<div className="sh-ex-scroll">
				<div
					className={invalid === null ? "sh-ex-note" : "sh-ex-note sh-ex-note-err"}
					role={invalid === null ? undefined : "alert"}
				>
					{invalid ?? "The matches are listed in the Search results panel under the editor."}
				</div>
			</div>
		</>
	);
}

function Toggle({
	on,
	label,
	onClick,
	children,
}: {
	on: boolean;
	label: string;
	onClick(): void;
	children: ReactNode;
}): ReactNode {
	return (
		<button
			type="button"
			className="sh-ex-icon-btn sh-ex-toggle"
			aria-pressed={on}
			aria-label={label}
			title={label}
			onClick={onClick}
		>
			{children}
		</button>
	);
}
