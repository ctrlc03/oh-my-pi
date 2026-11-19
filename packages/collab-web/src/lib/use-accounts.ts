import type { AccountChoice, AccountRow } from "@oh-my-pi/pi-wire/accounts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "./companion";

export interface AccountsControl {
	/** The computer's accounts; null until the first answer, and while there is no companion to ask. */
	rows: AccountRow[] | null;
	/** Why the accounts could not be read or the last switch was refused; null otherwise. */
	error: string | null;
	/** The provider whose default is being changed; its buttons wait for the companion. */
	switching: string | null;
	/** Make an account the default for new sessions (`identityKey: null`: automatic). */
	use(choice: AccountChoice): void;
}

/**
 * The accounts of the computer behind `client` (null: none to ask, such as a read-only link or a companion
 * without `canAccounts`), read once and again after every switch, which the companion answers with the
 * accounts as they are then.
 */
export function useAccounts(client: CompanionClient | null): AccountsControl {
	const [rows, setRows] = useState<AccountRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [switching, setSwitching] = useState<string | null>(null);
	// The client an answer was asked of: a late answer from another computer is dropped.
	const current = useRef(client);
	current.current = client;

	useEffect(() => {
		setRows(null);
		setError(null);
		setSwitching(null);
		if (client === null) return;
		client.accounts().then(
			list => {
				if (current.current === client) setRows(list);
			},
			(err: unknown) => {
				if (current.current === client) setError(err instanceof Error ? err.message : String(err));
			},
		);
	}, [client]);

	const use = useCallback(
		(choice: AccountChoice): void => {
			if (client === null) return;
			setSwitching(choice.provider);
			setError(null);
			client.accounts(choice).then(
				list => {
					if (current.current !== client) return;
					setRows(list);
					setSwitching(null);
				},
				(err: unknown) => {
					if (current.current !== client) return;
					setError(err instanceof Error ? err.message : String(err));
					setSwitching(null);
				},
			);
		},
		[client],
	);

	return { rows, error, switching, use };
}
