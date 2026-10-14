import type { PersonalProposal } from "@oh-my-pi/pi-wire/personal";
import type { ReactNode } from "react";
import { useState } from "react";
import { DECIDED_STATUSES, mergeNewest, proposalWhen } from "../../lib/personal-activity";
import { usePersonal, usePersonalQuery } from "../../lib/use-personal";
import { Choice } from "../settings/SettingsRows";
import { DigestView } from "./DigestView";
import { EventsList } from "./EventsList";
import { ProposalCard } from "./ProposalCard";
import { HomeGate, QueryView } from "./shared";
import { ShowOlder, useFeed } from "./use-feed";
import "./activity.css";

type View = "proposals" | "digests" | "events";
type Filter = "pending" | "decided";

const DIGEST_PAGE = 20;

/** Settings → Personal agent → Activity: what the agent proposes, what it learned, and what reached it. */
export function ActivityTab(): ReactNode {
	return (
		<HomeGate>
			<Activity />
		</HomeGate>
	);
}

function Activity(): ReactNode {
	const { home } = usePersonal();
	const [view, setView] = useState<View>("proposals");
	const waiting = home.status?.counts.proposals ?? 0;
	const unread = home.status?.counts.digests ?? 0;
	return (
		<div className="pa-act">
			<div className="pa-act-bar">
				<Choice<View>
					label="Activity"
					value={view}
					onChange={setView}
					options={[
						{ value: "proposals", label: waiting > 0 ? `Proposals (${waiting})` : "Proposals" },
						{ value: "digests", label: unread > 0 ? `Digests (${unread})` : "Digests" },
						{ value: "events", label: "Events" },
					]}
				/>
			</div>
			{view === "proposals" && <Proposals />}
			{view === "digests" && <Digests />}
			{view === "events" && <EventsList />}
		</div>
	);
}

function Proposals(): ReactNode {
	const personal = usePersonal();
	const [filter, setFilter] = useState<Filter>("pending");
	// What the owner just decided stays on the list, with its result, until they leave the filter.
	const [touched, setTouched] = useState<Record<string, PersonalProposal>>({});
	const pending = usePersonalQuery(
		personal,
		["proposals"],
		async call => (await call({ t: "personal-proposals", status: "pending" })).proposals,
		filter === "pending",
	);
	const decided = usePersonalQuery(
		personal,
		["proposals"],
		async call => {
			const lists = await Promise.all(
				DECIDED_STATUSES.map(async status => (await call({ t: "personal-proposals", status })).proposals),
			);
			return mergeNewest(proposalWhen, ...lists);
		},
		filter === "decided",
	);
	const changeFilter = (next: Filter): void => {
		setTouched({});
		setFilter(next);
	};

	return (
		<>
			<div className="pa-act-bar">
				<Choice<Filter>
					label="Proposals to show"
					value={filter}
					onChange={changeFilter}
					options={[
						{ value: "pending", label: "Pending" },
						{ value: "decided", label: "Decided" },
					]}
				/>
			</div>
			{filter === "pending" ? (
				<QueryView query={pending} what="proposals">
					{fetched => {
						const shown = mergeNewest(proposal => proposal.at, fetched, Object.values(touched));
						return shown.length === 0 ? (
							<div className="sh-companion-empty">
								No proposals waiting. When the agent learns something about you it will propose a line for About
								you here; nothing changes until you accept.
							</div>
						) : (
							<ProposalList
								proposals={shown}
								onChanged={proposal => setTouched(prev => ({ ...prev, [proposal.id]: proposal }))}
							/>
						);
					}}
				</QueryView>
			) : (
				<QueryView query={decided} what="proposals">
					{shown =>
						shown.length === 0 ? (
							<div className="sh-companion-empty">
								Nothing decided yet. Proposals you accept or reject are kept here.
							</div>
						) : (
							<ProposalList proposals={shown} />
						)
					}
				</QueryView>
			)}
		</>
	);
}

function ProposalList({
	proposals,
	onChanged,
}: {
	proposals: readonly PersonalProposal[];
	onChanged?(proposal: PersonalProposal): void;
}): ReactNode {
	return (
		<ul className="pa-act-list">
			{proposals.map(proposal => (
				<li key={proposal.id}>
					<ProposalCard proposal={proposal} onChanged={onChanged} />
				</li>
			))}
		</ul>
	);
}

function Digests(): ReactNode {
	const personal = usePersonal();
	const feed = useFeed(personal, ["digests"], DIGEST_PAGE, async (call, before) => {
		const reply = await call({ t: "personal-digests", limit: DIGEST_PAGE, before });
		return reply.digests;
	});
	return (
		<QueryView query={feed.query} what="digests">
			{() =>
				feed.items.length === 0 ? (
					<div className="sh-companion-empty">
						No digests yet. After the nightly review the agent writes what it learned here.
					</div>
				) : (
					<>
						<ul className="pa-act-list">
							{feed.items.map(digest => (
								<li key={digest.id}>
									<DigestView digest={digest} />
								</li>
							))}
						</ul>
						<ShowOlder feed={feed} />
					</>
				)
			}
		</QueryView>
	);
}
