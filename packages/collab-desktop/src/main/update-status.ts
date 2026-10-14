/** Where the self-updater is, as the menu shows it. */
export type UpdateStatus =
	| { kind: "idle" }
	| { kind: "checking" }
	| { kind: "current" }
	| { kind: "downloading"; tag: string; percent: number }
	/** Downloaded, verified and unpacked: it is installed when the app quits. */
	| { kind: "ready"; tag: string }
	| { kind: "failed"; message: string }
	/** This build cannot update itself (a development build, a platform without a release). */
	| { kind: "unsupported"; reason: string };

export interface UpdateMenuItem {
	label: string;
	enabled: boolean;
	/** What clicking does. */
	action: "check" | "restart" | "none";
}

export function updateMenuItem(status: UpdateStatus): UpdateMenuItem | null {
	switch (status.kind) {
		case "unsupported":
			return null;
		case "checking":
			return { label: "Checking for Updates…", enabled: false, action: "none" };
		case "downloading":
			return { label: `Downloading Update… ${status.percent}%`, enabled: false, action: "none" };
		case "ready":
			return { label: `Restart to Update to ${status.tag}`, enabled: true, action: "restart" };
		default:
			return { label: "Check for Updates…", enabled: true, action: "check" };
	}
}
