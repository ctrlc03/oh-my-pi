import { Laptop } from "lucide-react";
import type { ReactNode } from "react";

/** Names the computer a session or room lives on. Shown only where there are several computers to tell apart. */
export function ComputerChip({ name }: { name: string }): ReactNode {
	return (
		<span className="sh-chip sh-computer-chip" title={`On ${name}`}>
			<Laptop size={11} aria-hidden="true" />
			<span>{name}</span>
		</span>
	);
}
