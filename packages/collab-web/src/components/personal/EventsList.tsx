import type { PersonalEventRecord } from "@oh-my-pi/pi-wire/personal";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { relTime } from "../../lib/format";
import { EVENT_TRUST, eventKind, eventStatus, webUrl } from "../../lib/personal-activity";
import { usePersonal } from "../../lib/use-personal";
import { QueryView } from "./shared";
import { ShowOlder, useFeed } from "./use-feed";
import "./activity.css";

const PAGE = 50;

/** What reached the agent, newest first: schedules, scripts, GitHub and sources, with what became of each. */
export function EventsList(): ReactNode {
	const personal = usePersonal();
	const feed = useFeed(personal, ["events"], PAGE, async (call, before) => {
		const reply = await call({ t: "personal-events", limit: PAGE, before });
		return reply.events;
	});
	return (
		<QueryView query={feed.query} what="events">
			{() =>
				feed.items.length === 0 ? (
					<div className="sh-companion-empty">
						No events yet. Schedules, scripts (POST /event), GitHub and sources show up here.
					</div>
				) : (
					<>
						<ul className="pa-act-list">
							{feed.items.map(event => (
								<EventRow key={event.id} event={event} />
							))}
						</ul>
						<ShowOlder feed={feed} />
					</>
				)
			}
		</QueryView>
	);
}

function EventRow({ event }: { event: PersonalEventRecord }): ReactNode {
	const status = eventStatus(event);
	const trust = EVENT_TRUST[event.trust];
	const url = webUrl(event.url);
	return (
		<li className="pa-evt">
			<div className="pa-evt-head">
				<span className="pa-evt-source">{event.source}</span>
				<span className="pa-act-meta">
					<span className={`pa-act-tag pa-act-tag-${trust.tone}`}>{trust.label}</span>
					<span className={`pa-act-tag pa-act-tag-${status.tone}`}>{status.label}</span>
					<span>{relTime(event.at)}</span>
				</span>
			</div>
			<div className="pa-evt-title">{event.title}</div>
			<div className="sh-field-hint">{eventKind(event)}</div>
			{event.detail !== undefined && event.detail !== "" && <div className="pa-evt-detail">{event.detail}</div>}
			{url !== null && (
				<a className="pa-evt-link" href={url} target="_blank" rel="noreferrer">
					<ExternalLink size={12} aria-hidden="true" />
					<span>{url}</span>
				</a>
			)}
		</li>
	);
}
