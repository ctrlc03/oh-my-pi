/**
 * Standalone Bun process publishing a fixture Collab host until killed.
 * Used by registry-smoke.test.ts for discovery, explicit link retrieval,
 * crash cleanup, and the real CLI path.
 *
 * argv[2]  metadata dir override; empty/absent → default `~/.omp/run/collab-hosts`.
 * argv[3]  URL marker; falls back to OMP_SMOKE_MARKER, then "smoke".
 * argv[4]  instance ID; falls back to OMP_SMOKE_INSTANCE_ID, then "smoke-host".
 * OMP_SMOKE_MODE=idle  publish an idle (not hosting) entry instead; a `start`
 *          request makes it host the same fixture room, like a real omp would.
 *
 * Emits `READY\n` once published. SIGTERM closes the publication and exits 0.
 */
import {
	type CollabHostPublication,
	type CollabHostRegistrySource,
	publishCollabHost,
	publishCollabIdle,
} from "../../../src/collab/registry";

const dirArg = process.argv[2];
const marker = process.argv[3] ?? process.env.OMP_SMOKE_MARKER ?? "smoke";
const instanceId = process.argv[4] ?? process.env.OMP_SMOKE_INSTANCE_ID ?? "smoke-host";
const dir = dirArg && dirArg.length > 0 ? dirArg : undefined;
const startedAt = Date.now();

const source: CollabHostRegistrySource = {
	snapshot: () => ({
		instanceId,
		generation: 1,
		sessionId: `session-${marker}`,
		sessionName: `Smoke ${marker}`,
		cwd: process.cwd(),
		pid: process.pid,
		model: null,
		startedAt,
		participants: 1,
		relayConnected: true,
		inputRequired: false,
		busy: false,
		access: "control",
	}),
	link: access => `https://collab.example/${access}/${marker}`,
};
const publications: CollabHostPublication[] = [];
const idle = process.env.OMP_SMOKE_MODE === "idle";
let hosting = !idle;
if (idle) {
	publications.push(
		await publishCollabIdle(
			{
				snapshot: () => {
					if (hosting) throw new Error("already hosting");
					return {
						instanceId,
						pid: process.pid,
						sessionId: `session-${marker}`,
						sessionName: `Smoke ${marker}`,
						cwd: process.cwd(),
						model: null,
						startedAt,
						busy: false,
					};
				},
				start: async access => {
					hosting = true;
					publications.push(await publishCollabHost(source, { dir, instanceId }));
					return { generation: 1, access, url: source.link(access) ?? "" };
				},
			},
			{ dir, instanceId },
		),
	);
} else {
	publications.push(await publishCollabHost(source, { dir, instanceId }));
}

const shutdown = (): void => {
	Promise.all(publications.map(publication => publication.close())).then(
		() => process.exit(0),
		() => process.exit(0),
	);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdout.write("READY\n");

// Stay alive until a signal arrives (or the parent SIGKILLs us).
await Promise.withResolvers<never>().promise;
