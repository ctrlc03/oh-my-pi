/**
 * Runtime local Collab host registry.
 *
 * Every connected Collab host publishes a private, per-process IPC endpoint
 * (Unix domain socket on POSIX, named pipe on Windows) so that a separate local
 * process can discover live hosts and, on explicit request, retrieve a
 * shareable URL. The registry exposes two contracts over that endpoint:
 *
 * - `snapshot`: non-capability metadata (identity, session, cwd, model,
 *   participants, relay/attention/activity state) suitable for listing and
 *   polling;
 * - `link`: one browser URL for one exact host generation and access level,
 *   rejected when the generation moved or the access level is not published.
 *
 * Full-control and view-only URLs, room keys, and write tokens stay in host
 * memory; disk carries only ephemeral discovery metadata (protocol version,
 * instance ID, PID, endpoint, creation time, random bearer token) with
 * owner-only permissions. Endpoints die with the host process, so a crash
 * leaves at most stale metadata that the next list operation prunes best-effort.
 *
 * Transport follows the launch daemon broker conventions: node `net` servers,
 * newline-delimited JSON envelopes, per-request bearer authentication, and
 * bounded buffers. Guests never publish; hosts and idle processes do.
 *
 * Interactive processes that are not hosting publish an *idle* entry: same
 * directory, token, and socket model, but version-2 metadata tagged
 * `kind: "idle"`. Its IPC offers `snapshot` (identity only) and `start`, which
 * makes the process host exactly as `/collab` would and returns the link for
 * the requested access. An omp that predates idle entries only understands
 * version 1: it skips the unknown version without connecting and prunes the
 * file only once the owning PID is gone, so idle entries never show up as
 * hosts there and never disturb its listing.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";

/** Discovery metadata / IPC protocol version of hosting rooms. Mixed omp versions fail safely. */
export const COLLAB_REGISTRY_VERSION = 1;
/**
 * Metadata / IPC version of idle entries. A version this omp's predecessors do
 * not know, so they skip (and never prune a live) entry instead of listing it
 * as a host or rejecting it as malformed.
 */
export const COLLAB_IDLE_REGISTRY_VERSION = 2;

/** Reject request lines beyond this size; a valid request is <300 bytes. */
const MAX_REQUEST_BYTES = 4 * 1024;
/** Reject responses beyond this size. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * Longest string any snapshot field is sent with. Session names, imported
 * session ids, and working directories have no length limit of their own;
 * bounding them here keeps every valid snapshot response (five such fields,
 * worst case fully escaped) well inside {@link MAX_RESPONSE_BYTES}, so an
 * unusual title never makes an otherwise healthy host invisible.
 */
const MAX_SNAPSHOT_FIELD_CHARS = 1024;
/** Per-entry connect+response deadline during listing. */
const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
/** Concurrency bound for querying discovery entries. */
const LIST_CONCURRENCY = 8;
/** Idle `start` replies once the room is open: the host's relay connect timeout (15 s) plus slack. */
const DEFAULT_START_TIMEOUT_MS = 30_000;
/** Longest failure message sent over an endpoint. */
const MAX_ERROR_MESSAGE_CHARS = 300;

/** Access a link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabAccess = "view" | "control";

/**
 * Non-capability host state, computed by the host process at query time.
 * Free-form strings (session id and name, cwd, model) are bounded to
 * {@link MAX_SNAPSHOT_FIELD_CHARS} characters on the wire.
 */
export interface CollabHostSnapshot {
	/** Random per-process identity; stable across the host's room generations. */
	instanceId: string;
	/** Increments every time this process starts a new room (session switch, restart). */
	generation: number;
	/** Host process ID. */
	pid: number;
	/** Session ID of the hosted conversation. */
	sessionId: string;
	/** Human-readable session name, when one is set. */
	sessionName: string | null;
	/** Host working directory. */
	cwd: string;
	/** Model the host session is currently using, when one is selected. */
	model: { provider: string; id: string } | null;
	/** Epoch milliseconds when the host first connected to the relay. */
	startedAt: number;
	/** Current participant count, including the host. */
	participants: number;
	/** Whether the host currently holds an open relay connection. */
	relayConnected: boolean;
	/** Whether a host-side question is waiting for an answer a writable guest could give. */
	inputRequired: boolean;
	/**
	 * Whether the session is running a turn: streaming a response or executing
	 * tools. A poller watching this fall from `true` to `false` sees the host
	 * stop working while it is still published, which no other field reports —
	 * disappearing from discovery means the process died or became unreachable,
	 * not that the agent finished.
	 *
	 * `null` when the host does not report it (an omp older than this field).
	 * Unknown is not idle: a consumer must not read the absence as a session
	 * that stopped.
	 */
	busy: boolean | null;
	/** Highest access the registry will hand out for this host. */
	access: CollabAccess;
}

/** Live host state served over the IPC endpoint. */
export interface CollabHostRegistrySource {
	/** Current metadata; throws when the host can no longer vouch for its session. */
	snapshot(): CollabHostSnapshot;
	/** Browser URL for `access`, or `null` when that access is not published. */
	link(access: CollabAccess): string | null;
}

/** One resolved capability returned by {@link resolveCollabHostLink}. */
export interface CollabResolvedLink {
	instanceId: string;
	generation: number;
	access: CollabAccess;
	url: string;
}

/**
 * Non-capability state of an interactive omp process that is not hosting.
 * Free-form strings are bounded to {@link MAX_SNAPSHOT_FIELD_CHARS} on the wire.
 */
export interface CollabIdleSnapshot {
	/** Random per-process identity; shared with the process's host entries once it hosts. */
	instanceId: string;
	/** Process ID. */
	pid: number;
	/** Session ID of the conversation the process is driving. */
	sessionId: string;
	/** Human-readable session name, when one is set. */
	sessionName: string | null;
	/** Working directory of the session. */
	cwd: string;
	/** Model the session is currently using, when one is selected. */
	model: { provider: string; id: string } | null;
	/** Epoch milliseconds when the process started. */
	startedAt: number;
	/** Whether the session is running a turn right now. */
	busy: boolean;
}

/** Result of starting hosting through an idle entry; carries the capability for `access`. */
export interface CollabIdleStartResult {
	generation: number;
	access: CollabAccess;
	url: string;
}

/** Live process state served over an idle entry's IPC endpoint. */
export interface CollabIdleRegistrySource {
	/** Current metadata; throws while the process cannot be started hosting (hosting already, guest, shutting down). */
	snapshot(): CollabIdleSnapshot;
	/**
	 * Start hosting with at most `access` and resolve once the room is open and
	 * published. Throws {@link CollabLinkError} (`not_startable`,
	 * `access_unavailable`, `start_failed`) when it cannot.
	 */
	start(access: CollabAccess): Promise<CollabIdleStartResult>;
}

/** Hosts and idle processes found by {@link listCollabSessions}. */
export interface CollabSessionListing {
	hosts: CollabHostSnapshot[];
	idle: CollabIdleSnapshot[];
}

/** Handle returned by {@link publishCollabHost}; closing withdraws the host. */
export interface CollabHostPublication {
	/** Endpoint the host listens on (test/diagnostic use; not secret). */
	readonly endpoint: string;
	/** Stop serving requests and remove the discovery metadata. Idempotent. */
	close(): Promise<void>;
}

export interface CollabRegistryOptions {
	/** Override the discovery metadata directory (tests). */
	dir?: string;
}

export interface CollabPublishOptions extends CollabRegistryOptions {
	/**
	 * Identity recorded in the metadata and matched by `omp collab link <id>`.
	 * Defaults to a fresh random ID; a host that rotates rooms passes its
	 * process-lifetime instance ID so the replacement room keeps the same id.
	 * The metadata file and endpoint are always named per publication, so a
	 * stale entry and its successor never share artifacts.
	 */
	instanceId?: string;
	/**
	 * Base for the short socket directory used when the canonical socket path
	 * would overflow `sun_path`. Defaults to `/tmp`; tests point it elsewhere.
	 */
	socketFallbackBase?: string;
}

export interface CollabListOptions extends CollabRegistryOptions {
	/** Per-entry query deadline in milliseconds. */
	timeoutMs?: number;
}

export interface CollabRemoteStartOptions extends CollabListOptions {
	/** Deadline for an idle process to open and publish its room, in milliseconds. */
	startTimeoutMs?: number;
}

/** Stable failure codes for {@link resolveCollabHostLink}; never carry URLs. */
export type CollabLinkErrorCode =
	| "not_found"
	| "ambiguous"
	| "stale_generation"
	| "access_unavailable"
	| "unreachable"
	| "not_startable"
	| "start_failed";

export class CollabLinkError extends Error {
	readonly code: CollabLinkErrorCode;
	constructor(code: CollabLinkErrorCode, message: string) {
		super(message);
		this.name = "CollabLinkError";
		this.code = code;
	}
}

/**
 * Discovery metadata directory. Deliberately under the profile-independent
 * config root (`~/.omp/run/collab-hosts`) — unlike the launch broker's
 * profile-scoped runtime dir — so hosts started under any profile are
 * discoverable from any other (issue #6099 user story 18).
 */
export function collabHostsRuntimeDir(): string {
	return path.join(getBaseConfigRoot(), "run", "collab-hosts");
}

interface DiscoveryMetadata {
	version: number;
	/** Entry flavour for version 2 and later; absent on host entries. */
	kind?: string;
	instanceId: string;
	pid: number;
	endpoint: string;
	createdAt: number;
	token: string;
}

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

function parseDiscoveryMetadata(text: string): DiscoveryMetadata | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const meta = raw as Record<string, unknown>;
	if (typeof meta.version !== "number") return null;
	if (typeof meta.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(meta.instanceId)) return null;
	if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 0) return null;
	if (typeof meta.endpoint !== "string" || meta.endpoint.length === 0) return null;
	if (typeof meta.createdAt !== "number") return null;
	if (typeof meta.token !== "string" || meta.token.length === 0) return null;
	return {
		version: meta.version,
		kind: typeof meta.kind === "string" ? meta.kind : undefined,
		instanceId: meta.instanceId,
		pid: meta.pid,
		endpoint: meta.endpoint,
		createdAt: meta.createdAt,
		token: meta.token,
	};
}

function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

function isAccess(value: unknown): value is CollabAccess {
	return value === "view" || value === "control";
}

/** `undefined` for a malformed model, `null` for no model. */
function parseModel(value: unknown): CollabHostSnapshot["model"] | undefined {
	if (value === null) return null;
	if (typeof value !== "object") return undefined;
	const { provider, id } = value as Record<string, unknown>;
	if (typeof provider !== "string" || typeof id !== "string") return undefined;
	return { provider, id };
}

function parseSnapshot(raw: unknown): CollabHostSnapshot | null {
	if (typeof raw !== "object" || raw === null) return null;
	const host = raw as Record<string, unknown>;
	if (typeof host.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(host.instanceId)) return null;
	if (typeof host.generation !== "number" || !Number.isInteger(host.generation) || host.generation < 1) return null;
	if (typeof host.pid !== "number" || !Number.isInteger(host.pid)) return null;
	if (typeof host.sessionId !== "string") return null;
	if (host.sessionName !== null && typeof host.sessionName !== "string") return null;
	if (typeof host.cwd !== "string") return null;
	const model = parseModel(host.model);
	if (model === undefined) return null;
	if (typeof host.startedAt !== "number") return null;
	if (typeof host.participants !== "number") return null;
	if (typeof host.relayConnected !== "boolean") return null;
	if (typeof host.inputRequired !== "boolean") return null;
	// `busy` was added after the protocol version shipped, and the version is a
	// hard gate on both sides: bumping it would make every host invisible to a
	// differently versioned lister on the same machine. So an older host's
	// snapshot simply omits the field, and a missing one reads as unknown
	// (`null`) rather than rejecting an otherwise healthy host.
	if (host.busy !== undefined && host.busy !== null && typeof host.busy !== "boolean") return null;
	if (!isAccess(host.access)) return null;
	return {
		instanceId: host.instanceId,
		generation: host.generation,
		pid: host.pid,
		sessionId: host.sessionId,
		sessionName: host.sessionName,
		cwd: host.cwd,
		model,
		startedAt: host.startedAt,
		participants: host.participants,
		relayConnected: host.relayConnected,
		inputRequired: host.inputRequired,
		busy: typeof host.busy === "boolean" ? host.busy : null,
		access: host.access,
	};
}

function parseIdleSnapshot(raw: unknown): CollabIdleSnapshot | null {
	if (typeof raw !== "object" || raw === null) return null;
	const idle = raw as Record<string, unknown>;
	if (typeof idle.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(idle.instanceId)) return null;
	if (typeof idle.pid !== "number" || !Number.isInteger(idle.pid) || idle.pid <= 0) return null;
	if (typeof idle.sessionId !== "string") return null;
	if (idle.sessionName !== null && typeof idle.sessionName !== "string") return null;
	if (typeof idle.cwd !== "string") return null;
	const model = parseModel(idle.model);
	if (model === undefined) return null;
	if (typeof idle.startedAt !== "number") return null;
	if (typeof idle.busy !== "boolean") return null;
	return {
		instanceId: idle.instanceId,
		pid: idle.pid,
		sessionId: idle.sessionId,
		sessionName: idle.sessionName,
		cwd: idle.cwd,
		model,
		startedAt: idle.startedAt,
		busy: idle.busy,
	};
}

function boundField(value: string): string {
	return value.length > MAX_SNAPSHOT_FIELD_CHARS ? value.slice(0, MAX_SNAPSHOT_FIELD_CHARS) : value;
}

/** A failure message as sent on the wire: single line, bounded. */
function boundMessage(message: string): string {
	const line = message.replace(/\p{Cc}+/gu, " ").trim();
	return line.length > MAX_ERROR_MESSAGE_CHARS ? line.slice(0, MAX_ERROR_MESSAGE_CHARS) : line;
}

/** The snapshot as sent on the wire: every free-form string bounded to {@link MAX_SNAPSHOT_FIELD_CHARS}. */
function boundSnapshot<T extends Pick<CollabHostSnapshot, "sessionId" | "sessionName" | "cwd" | "model">>(
	snapshot: T,
): T {
	return {
		...snapshot,
		sessionId: boundField(snapshot.sessionId),
		sessionName: snapshot.sessionName === null ? null : boundField(snapshot.sessionName),
		cwd: boundField(snapshot.cwd),
		model: snapshot.model
			? { provider: boundField(snapshot.model.provider), id: boundField(snapshot.model.id) }
			: null,
	};
}

/** Answers one authenticated, version-matched request; `v` is added to the payload when it is sent. */
type RequestDispatch = (request: Record<string, unknown>) => object | Promise<object>;

/** One request per connection: authenticate, dispatch the op, respond, close. */
function handleConnection(socket: net.Socket, token: string, version: number, dispatch: RequestDispatch): void {
	let buffer = "";
	let handled = false;
	const respond = (payload: object): void => {
		handled = true;
		socket.end(`${JSON.stringify({ ...payload, v: version })}\n`);
	};
	const fail = (error: string): void => respond({ ok: false, error });
	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.on("data", chunk => {
		if (handled) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
			socket.destroy();
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline).trim();
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			fail("malformed_request");
			return;
		}
		if (typeof request !== "object" || request === null) {
			fail("malformed_request");
			return;
		}
		const fields = request as Record<string, unknown>;
		if (fields.v !== version) {
			fail("unsupported_protocol");
			return;
		}
		if (!tokenMatches(token, fields.token)) {
			fail("authentication_failed");
			return;
		}
		// An op may take a while (starting a room); ignore anything else on the connection meanwhile.
		handled = true;
		Promise.resolve()
			.then(() => dispatch(fields))
			.then(respond, () => fail("operation_failed"));
	});
}

function hostDispatch(source: CollabHostRegistrySource): RequestDispatch {
	return request => {
		const { op, access, generation } = request;
		let snapshot: CollabHostSnapshot;
		try {
			snapshot = source.snapshot();
		} catch {
			// Never let source errors (or URLs) leak into the wire error.
			return { ok: false, error: "snapshot_unavailable" };
		}
		if (op === "snapshot") return { ok: true, snapshot: boundSnapshot(snapshot) };
		if (op !== "link") return { ok: false, error: "invalid_operation" };
		if (!isAccess(access)) return { ok: false, error: "invalid_access" };
		// A capability is bound to the exact generation the caller listed: a room
		// that rotated underneath a stale card must not hand out its successor.
		if (generation !== snapshot.generation) return { ok: false, error: "stale_generation" };
		if (access === "control" && snapshot.access !== "control") return { ok: false, error: "access_unavailable" };
		let url: string | null;
		try {
			url = source.link(access);
		} catch {
			return { ok: false, error: "snapshot_unavailable" };
		}
		if (!url) return { ok: false, error: "access_unavailable" };
		return { ok: true, url };
	};
}

function idleDispatch(source: CollabIdleRegistrySource): RequestDispatch {
	return async request => {
		const { op, access } = request;
		if (op === "snapshot") {
			try {
				return { ok: true, snapshot: boundSnapshot(source.snapshot()) };
			} catch {
				return { ok: false, error: "snapshot_unavailable" };
			}
		}
		if (op !== "start") return { ok: false, error: "invalid_operation" };
		if (!isAccess(access)) return { ok: false, error: "invalid_access" };
		try {
			const started = await source.start(access);
			return { ok: true, generation: started.generation, access: started.access, url: started.url };
		} catch (err) {
			// The caller is the same OS user on an owner-only socket; a reason is
			// what lets `omp collab start` explain a failure. Messages never carry links.
			if (err instanceof CollabLinkError) return { ok: false, error: err.code, message: boundMessage(err.message) };
			return {
				ok: false,
				error: "start_failed",
				message: boundMessage(err instanceof Error ? err.message : String(err)),
			};
		}
	};
}

/**
 * The registry must be a real directory; POSIX also verifies its owner.
 * Both publication and listing check this: listing prunes malformed
 * entries, so following a symlink into an unrelated directory would let a
 * planted link turn `omp collab list` into a deletion tool.
 */
async function assertPrivateDir(dir: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`collab registry directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`collab registry path is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`collab registry directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

/**
 * Create the directory with owner-only POSIX permissions. Windows retains
 * the config root's ACL. `mkdir` with a mode leaves an
 * existing directory's permissions alone, so an already-present directory is
 * tightened explicitly; a symlink or a directory owned by another user is
 * refused rather than published into.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/** `sun_path` capacity: 104 bytes on macOS, 108 elsewhere; the kernel rejects paths at or past it. */
const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
const DEFAULT_SOCKET_FALLBACK_BASE = "/tmp";

/**
 * Short owner-private socket directory for registries whose canonical path
 * would overflow `sun_path`: the relocation the SSH control sockets use
 * (#9070), keyed by uid and the canonical registry directory.
 */
function socketFallbackDir(dir: string, base: string): string {
	const key = new Bun.CryptoHasher("sha256")
		.update(String(process.getuid?.() ?? 0))
		.update("\0")
		.update(dir)
		.digest("hex")
		.slice(0, 20);
	return path.join(base, `omp-collab-${key}`);
}

/**
 * Where this publication's Unix socket lives. The canonical location is next
 * to the metadata, but a deep config root (long home directory, nested
 * `PI_CONFIG_DIR`) can push that past `sun_path`, and a host that cannot bind
 * would silently stay absent from `omp collab list`. Listers never guess the
 * relocated path; the metadata records the endpoint.
 */
async function resolveSocketEndpoint(dir: string, entryId: string, fallbackBase: string): Promise<string> {
	const canonical = path.join(dir, `${entryId}.sock`);
	if (Buffer.byteLength(canonical) < SUN_PATH_LIMIT) return canonical;
	const shortDir = socketFallbackDir(dir, fallbackBase);
	await ensurePrivateDir(shortDir);
	return path.join(shortDir, `${entryId}.sock`);
}

/** Metadata flavour of one publication: its version and (for idle entries) kind tag. */
interface EntryProtocol {
	version: number;
	kind?: "idle";
}

/**
 * Publish a live Collab host to the local registry.
 *
 * Creates the owner-only runtime dir, starts a private IPC endpoint backed by
 * `source`, and writes discovery metadata (never URLs or room secrets).
 * Call {@link CollabHostPublication.close} on every teardown path; a process
 * exit hook removes the on-disk state for normal shutdown, and the OS closing
 * the endpoint covers crashes.
 */
export function publishCollabHost(
	source: CollabHostRegistrySource,
	options?: CollabPublishOptions,
): Promise<CollabHostPublication> {
	return publishEntry(options, { version: COLLAB_REGISTRY_VERSION }, hostDispatch(source));
}

/**
 * Publish an idle (not hosting) interactive process, so `omp collab list`
 * reports it under `idle` and `omp collab start` can make it host. Same
 * artifacts and lifecycle as {@link publishCollabHost}; the entry stays
 * published for the life of the process and its `source` reports itself
 * unavailable while the process cannot be started.
 */
export function publishCollabIdle(
	source: CollabIdleRegistrySource,
	options?: CollabPublishOptions,
): Promise<CollabHostPublication> {
	return publishEntry(options, { version: COLLAB_IDLE_REGISTRY_VERSION, kind: "idle" }, idleDispatch(source));
}

async function publishEntry(
	options: CollabPublishOptions | undefined,
	protocol: EntryProtocol,
	dispatch: RequestDispatch,
): Promise<CollabHostPublication> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	await ensurePrivateDir(dir);

	const instanceId = options?.instanceId ?? crypto.randomBytes(8).toString("hex");
	if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error("invalid collab registry instance id");
	// Unpredictable per-publication entry ID names the endpoint and the metadata
	// file: PID reuse cannot attach stale metadata to an unrelated process, and a
	// room that rotates never shares artifact names with its predecessor, so a
	// lister pruning the stale entry can never remove the live successor's.
	const entryId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-collab-${entryId}`
			: await resolveSocketEndpoint(dir, entryId, options?.socketFallbackBase ?? DEFAULT_SOCKET_FALLBACK_BASE);
	const metaPath = path.join(dir, `${entryId}.json`);

	const liveSockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
		handleConnection(socket, token, protocol.version, dispatch);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", err => listening.reject(err));
	server.listen(endpoint, () => listening.resolve());
	try {
		await listening.promise;
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const meta: DiscoveryMetadata = {
			version: protocol.version,
			kind: protocol.kind,
			instanceId,
			pid: process.pid,
			endpoint,
			createdAt: Date.now(),
			token,
		};
		// Write-then-rename so a concurrent list never observes a partial file
		// (it would classify the entry as malformed and prune it, leaving this
		// host published but undiscoverable). The temp suffix keeps it outside
		// the `*.json` listing filter; the entry ID makes the name unique. Any
		// failure after the exclusive create removes the temp file again.
		const tmpPath = `${metaPath}.tmp`;
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			try {
				await handle.writeFile(JSON.stringify(meta), "utf8");
			} finally {
				await handle.close();
			}
			await fs.promises.rename(tmpPath, metaPath);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	} catch (err) {
		server.close();
		if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		throw err;
	}

	const removeArtifactsSync = (): void => {
		try {
			fs.rmSync(metaPath, { force: true });
			if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		} catch {
			// Best-effort; a survivor is pruned by the next list.
		}
	};
	// Normal process shutdown without an explicit stop still withdraws the host.
	process.once("exit", removeArtifactsSync);

	let closed = false;
	return {
		endpoint,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			process.off("exit", removeArtifactsSync);
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			// Sever any lingering clients so close() cannot hang on an open socket.
			for (const socket of liveSockets) socket.destroy();
			removeArtifactsSync();
			await done.promise;
		},
	};
}

type QueryResult<T> =
	| { status: "ok"; value: T }
	| { status: "dead" }
	| { status: "skip"; error?: string; message?: string };

/** Query one endpoint: connect, authenticate, send one request, read one bounded response line. */
function query(meta: DiscoveryMetadata, request: object, timeoutMs: number): Promise<QueryResult<unknown>> {
	const { promise, resolve } = Promise.withResolvers<QueryResult<unknown>>();
	let buffer = "";
	const socket = net.createConnection({ path: meta.endpoint });
	const timer = setTimeout(() => finish({ status: "skip" }), timeoutMs);
	const finish = (result: QueryResult<unknown>): void => {
		clearTimeout(timer);
		socket.destroy();
		resolve(result);
	};
	socket.setEncoding("utf8");
	socket.once("error", err => {
		// Endpoints die with their host process: a refused or missing socket
		// means the host is gone. Any other error (EMFILE, EACCES, EAGAIN, …)
		// says nothing about liveness and must not prune a live host.
		const code = (err as NodeJS.ErrnoException).code;
		finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
	});
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ v: meta.version, token: meta.token, ...request })}\n`);
	});
	socket.on("data", chunk => {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
			finish({ status: "skip" });
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		let response: unknown;
		try {
			response = JSON.parse(buffer.slice(0, newline));
		} catch {
			finish({ status: "skip" });
			return;
		}
		if (typeof response !== "object" || response === null) {
			finish({ status: "skip" });
			return;
		}
		const { ok, error, message } = response as Record<string, unknown>;
		if (ok !== true) {
			// Authentication failure or structured error: an unrelated endpoint
			// cannot satisfy stale metadata without the matching token.
			finish({
				status: "skip",
				error: typeof error === "string" ? error : undefined,
				message: typeof message === "string" ? message : undefined,
			});
			return;
		}
		finish({ status: "ok", value: response });
	});
	socket.once("close", () => finish({ status: "skip" }));
	return promise;
}

async function querySnapshot<T>(
	meta: DiscoveryMetadata,
	timeoutMs: number,
	parse: (raw: unknown) => T | null,
): Promise<QueryResult<T>> {
	const result = await query(meta, { op: "snapshot" }, timeoutMs);
	if (result.status !== "ok") return result;
	const snapshot = parse((result.value as Record<string, unknown>).snapshot);
	return snapshot ? { status: "ok", value: snapshot } : { status: "skip" };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Remove one stale entry. Artifact names are unique per publication, so the
 * metadata and endpoint observed dead can only belong to that publication;
 * a room that rotated meanwhile lives under different names and is untouched.
 */
async function pruneEntry(dir: string, name: string, meta: DiscoveryMetadata | null): Promise<void> {
	try {
		await fs.promises.rm(path.join(dir, name), { force: true });
		// Only unlink sockets this registry could have created: beside the
		// metadata, or in its own relocated socket directory.
		const ownsEndpoint =
			meta !== null &&
			process.platform !== "win32" &&
			(meta.endpoint.startsWith(dir + path.sep) ||
				meta.endpoint.startsWith(socketFallbackDir(dir, DEFAULT_SOCKET_FALLBACK_BASE) + path.sep));
		if (ownsEndpoint) await fs.promises.rm(meta.endpoint, { force: true });
	} catch {
		// Best-effort cleanup only (a missing file means someone else already pruned it).
	}
}

type EntryKind = "host" | "idle";

interface LiveHost {
	kind: "host";
	meta: DiscoveryMetadata;
	snapshot: CollabHostSnapshot;
}

interface LiveIdle {
	kind: "idle";
	meta: DiscoveryMetadata;
	snapshot: CollabIdleSnapshot;
}

type LiveEntry = LiveHost | LiveIdle;

/** Which published flavour `meta` is; `null` for a version or kind this omp does not know. */
function entryKind(meta: DiscoveryMetadata): EntryKind | null {
	if (meta.version === COLLAB_REGISTRY_VERSION) return "host";
	if (meta.version === COLLAB_IDLE_REGISTRY_VERSION && meta.kind === "idle") return "idle";
	return null;
}

async function listEntry(
	dir: string,
	name: string,
	timeoutMs: number,
	wanted: Record<EntryKind, boolean>,
): Promise<LiveEntry | null> {
	let text: string;
	try {
		text = await Bun.file(path.join(dir, name)).text();
	} catch {
		return null;
	}
	const meta = parseDiscoveryMetadata(text);
	if (!meta) {
		// Malformed metadata can never become listable; remove it.
		await pruneEntry(dir, name, null);
		return null;
	}
	const kind = entryKind(meta);
	// A version this omp does not know, or a flavour the caller did not ask
	// for, is never queried or shown. Prune it only once the owning process is
	// gone, so newer versions and the other flavour's listers keep live state.
	if (!kind || !wanted[kind]) {
		if (!pidAlive(meta.pid)) await pruneEntry(dir, name, meta);
		return null;
	}
	const result = await querySnapshot<LiveEntry>(meta, timeoutMs, raw => {
		const snapshot = kind === "host" ? parseSnapshot(raw) : parseIdleSnapshot(raw);
		return snapshot && ({ kind, meta, snapshot } as LiveEntry);
	});
	if (result.status === "ok") return result.value;
	if (result.status === "dead") await pruneEntry(dir, name, meta);
	return null;
}

function compareSnapshots(
	a: { startedAt: number; pid: number; instanceId: string },
	b: { startedAt: number; pid: number; instanceId: string },
): number {
	return a.startedAt - b.startedAt || a.pid - b.pid || a.instanceId.localeCompare(b.instanceId);
}

async function listLiveEntries(
	options: CollabListOptions | undefined,
	wanted: Record<EntryKind, boolean>,
): Promise<{ hosts: LiveHost[]; idle: LiveIdle[] }> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	let names: string[];
	try {
		await assertPrivateDir(dir);
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return { hosts: [], idle: [] };
		throw err;
	}
	const entries = names.filter(name => name.endsWith(".json")).sort();
	const hosts: LiveHost[] = [];
	const idle: LiveIdle[] = [];
	// Bounded worker pool: LIST_CONCURRENCY entries in flight at once.
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < entries.length) {
			const name = entries[next++];
			const entry = await listEntry(dir, name, timeoutMs, wanted);
			if (entry?.kind === "host") hosts.push(entry);
			else if (entry) idle.push(entry);
		}
	};
	await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, entries.length) }, worker));
	hosts.sort((a, b) => compareSnapshots(a.snapshot, b.snapshot));
	idle.sort((a, b) => compareSnapshots(a.snapshot, b.snapshot));
	// A process that started hosting between the two queries answers both
	// ways; it is hosting, not idle.
	const hostingIds = new Set(hosts.map(host => host.snapshot.instanceId));
	return { hosts, idle: idle.filter(entry => !hostingIds.has(entry.snapshot.instanceId)) };
}

/**
 * List live Collab hosts under this config root.
 *
 * Reads every discovery entry, queries the live hosts concurrently (bounded,
 * short independent deadlines), prunes stale or malformed entries
 * best-effort, and returns healthy hosts sorted by start time, PID, then
 * instance ID. Unreachable, unauthenticated, malformed, or version-mismatched
 * entries are omitted without failing the listing. The result carries no URLs.
 * Idle entries are neither queried nor returned; see {@link listCollabSessions}.
 */
export async function listCollabHosts(options?: CollabListOptions): Promise<CollabHostSnapshot[]> {
	return (await listLiveEntries(options, { host: true, idle: false })).hosts.map(entry => entry.snapshot);
}

/**
 * List live hosts and, separately, interactive processes that are not
 * hosting but can be started with {@link startCollabSession}. Same pruning,
 * bounds, and ordering as {@link listCollabHosts}; no URLs.
 */
export async function listCollabSessions(options?: CollabListOptions): Promise<CollabSessionListing> {
	const { hosts, idle } = await listLiveEntries(options, { host: true, idle: true });
	return { hosts: hosts.map(entry => entry.snapshot), idle: idle.map(entry => entry.snapshot) };
}

/** The entry named by `selector`: an exact instance ID, or a PID when no instance matches. */
function selectEntry<T extends { snapshot: { instanceId: string; pid: number } }>(
	entries: T[],
	selector: string,
	noun: string,
): T {
	const wanted = selector.trim();
	let matches = entries.filter(entry => entry.snapshot.instanceId === wanted);
	if (matches.length === 0 && /^[1-9][0-9]*$/.test(wanted)) {
		const pid = Number(wanted);
		matches = entries.filter(entry => entry.snapshot.pid === pid);
	}
	if (matches.length === 0) {
		throw new CollabLinkError("not_found", `no active ${noun} matches ${wanted}`);
	}
	if (matches.length > 1) {
		const ids = matches.map(entry => entry.snapshot.instanceId).join(", ");
		throw new CollabLinkError("ambiguous", `${wanted} matches more than one ${noun}; use an instance id: ${ids}`);
	}
	return matches[0];
}

/**
 * Request one capability from a listed host. The request carries the
 * generation observed while listing, so a host that rotated rooms in between
 * answers `stale_generation` instead of leaking its successor's capability.
 */
async function requestHostLink(
	{ meta, snapshot }: LiveHost,
	access: CollabAccess,
	options: CollabListOptions | undefined,
): Promise<CollabResolvedLink> {
	// No local access precheck: the host decides, and it checks the generation
	// before the access level, so a room that rotated underneath the listing
	// reports `stale_generation` rather than a verdict about its predecessor.
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	const result = await query(meta, { op: "link", access, generation: snapshot.generation }, timeoutMs);
	if (result.status === "ok") {
		const { url } = result.value as Record<string, unknown>;
		if (typeof url === "string" && url.length > 0) {
			return { instanceId: snapshot.instanceId, generation: snapshot.generation, access, url };
		}
		throw new CollabLinkError("unreachable", `host ${snapshot.instanceId} returned an invalid link response`);
	}
	if (result.status === "skip" && result.error === "stale_generation") {
		throw new CollabLinkError(
			"stale_generation",
			`host ${snapshot.instanceId} started a new room since it was listed; list again and retry`,
		);
	}
	if (result.status === "skip" && result.error === "access_unavailable") {
		throw new CollabLinkError("access_unavailable", `host ${snapshot.instanceId} does not publish ${access} access`);
	}
	if (result.status === "dead") {
		// Every room generation has its own endpoint, so a host that rotated
		// since the listing is simply gone from this one rather than answering
		// `stale_generation` itself. Look the instance up again before giving up.
		const rotated = (await listLiveEntries(options, { host: true, idle: false })).hosts.some(
			entry => entry.snapshot.instanceId === snapshot.instanceId && entry.snapshot.generation > snapshot.generation,
		);
		if (rotated) {
			throw new CollabLinkError(
				"stale_generation",
				`host ${snapshot.instanceId} started a new room since it was listed; list again and retry`,
			);
		}
	}
	throw new CollabLinkError("unreachable", `host ${snapshot.instanceId} did not answer the link request`);
}

/**
 * Resolve one browser URL for the host selected by `selector` — an exact
 * instance ID, or a PID when no instance matches.
 */
export async function resolveCollabHostLink(
	selector: string,
	access: CollabAccess,
	options?: CollabListOptions,
): Promise<CollabResolvedLink> {
	const { hosts } = await listLiveEntries(options, { host: true, idle: false });
	return requestHostLink(selectEntry(hosts, selector, "Collab host"), access, options);
}

/**
 * Make the process selected by `selector` (instance ID, or PID when no
 * instance matches) host and return the link for `access`. An idle process
 * starts a room exactly as `/collab` would and answers once it is open and
 * published; a process already hosting just hands out its existing link.
 */
export async function startCollabSession(
	selector: string,
	access: CollabAccess,
	options?: CollabRemoteStartOptions,
): Promise<CollabResolvedLink> {
	const { hosts, idle } = await listLiveEntries(options, { host: true, idle: true });
	const entry = selectEntry<LiveEntry>([...hosts, ...idle], selector, "omp session");
	if (entry.kind === "host") return requestHostLink(entry, access, options);
	const { instanceId } = entry.snapshot;
	const result = await query(entry.meta, { op: "start", access }, options?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
	if (result.status === "ok") {
		const { url, generation } = result.value as Record<string, unknown>;
		if (typeof url === "string" && url.length > 0 && typeof generation === "number" && Number.isInteger(generation)) {
			return { instanceId, generation, access, url };
		}
		throw new CollabLinkError("unreachable", `session ${instanceId} returned an invalid start response`);
	}
	if (result.status === "skip" && result.error) {
		const detail = result.message ? `: ${boundMessage(result.message)}` : "";
		if (result.error === "not_startable") {
			throw new CollabLinkError("not_startable", `session ${instanceId} cannot start hosting${detail}`);
		}
		if (result.error === "access_unavailable") {
			throw new CollabLinkError(
				"access_unavailable",
				`session ${instanceId} cannot grant ${access} access${detail}`,
			);
		}
		if (result.error === "start_failed") {
			throw new CollabLinkError("start_failed", `session ${instanceId} failed to start hosting${detail}`);
		}
	}
	throw new CollabLinkError(
		"unreachable",
		`session ${instanceId} did not answer the start request; run omp collab list to see whether it started`,
	);
}
