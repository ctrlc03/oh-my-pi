/**
 * The `blueprint-*` requests for scripts/mock-companion.ts, so architecture maps can be tried in a browser: a
 * list with a finished full map, a finished changes map, a stale one and a failed one; maps started from the form
 * that tick through their progress and turn ready; the code behind every citation, read from the small
 * repository ("acme-shop") embedded below. Every citation is placed by finding its token in the source, so the
 * fixture cannot cite a line that is not there.
 */

import type {
	Blueprint,
	BlueprintChange,
	BlueprintDiagram,
	BlueprintEdge,
	BlueprintExcerpt,
	BlueprintExcerptRef,
	BlueprintNode,
	BlueprintRef,
	BlueprintRefsAnswer,
	BlueprintSummary,
} from "@oh-my-pi/pi-wire/blueprint";
import * as fs from "node:fs";
import { BLUEPRINT_VERSION } from "@oh-my-pi/pi-wire/blueprint";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { excerptOf as readExcerpt } from "./companion-excerpt";

const sourceCache = new Map<string, string[] | null>();

/** Code around a citation read from a checkout (its working tree, not the map's commit: lines may differ). */
function excerptFromDir(dir: string, ref: BlueprintExcerptRef, commit: string): BlueprintExcerpt | null {
	const file = `${dir}/${ref.path}`;
	if (!sourceCache.has(file)) {
		try {
			sourceCache.set(file, fs.readFileSync(file, "utf8").split("\n"));
		} catch {
			sourceCache.set(file, null);
		}
	}
	const all = sourceCache.get(file);
	if (all === null || all === undefined) return null;
	const excerpt = readExcerpt(all, ref, ref.side ?? "head", commit);
	return excerpt === null ? null : { ...excerpt, language: LANGUAGES[ref.path.split(".").pop() ?? ""] };
}
export const MOCK_REPO_ROOT = "/work/acme-shop";
const HEAD_COMMIT = "9c41e07b3a5d2f86c1e04a7d5b93f2a1d60e8c47";
const BASE_COMMIT = "5be29d0c7f13a864e9d02b1c8a47e5f3906d1a22";
const MOVED_COMMIT = "a77f31c0d9e24b58163fc0a9d84e7b215c3f6e90";
const HOUR = 60 * 60 * 1000;

const SOURCE_FILES: Record<string, string> = {
	"src/web/Checkout.tsx": `import { useState } from "react";
import { api } from "./client";
import { CartSummary } from "./CartSummary";

export function Checkout({ cartId }: { cartId: string }) {
	const [status, setStatus] = useState<"idle" | "paying" | "paid" | "failed">("idle");

	async function pay() {
		setStatus("paying");
		const order = await api.post("/orders", { cartId });
		const result = await api.post(\`/orders/\${order.id}/pay\`, {});
		setStatus(result.ok ? "paid" : "failed");
	}

	return (
		<main>
			<CartSummary cartId={cartId} />
			<button disabled={status === "paying"} onClick={pay}>
				Pay now
			</button>
		</main>
	);
}
`,
	"src/web/client.ts": `import { readToken } from "./session";

const BASE = import.meta.env.VITE_API_URL ?? "/api";

export const api = {
	async post(path: string, body: unknown) {
		const res = await fetch(\`\${BASE}\${path}\`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: \`Bearer \${readToken()}\` },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(\`\${path} failed: \${res.status}\`);
		return res.json();
	},
};
`,
	"src/api/server.ts": `import { Hono } from "hono";
import { requireAuth } from "./auth";
import { createOrder, payOrder } from "../orders/service";

export const app = new Hono();

app.use("*", requireAuth);

app.post("/orders", async c => {
	const { cartId } = await c.req.json();
	const order = await createOrder(c.get("userId"), cartId);
	return c.json(order, 201);
});

app.post("/orders/:id/pay", async c => {
	const result = await payOrder(c.req.param("id"));
	return c.json(result);
});
`,
	"src/api/auth.ts": `import { verifyJwt } from "./jwt";

export async function requireAuth(c: Context, next: Next) {
	const header = c.req.header("authorization") ?? "";
	const claims = await verifyJwt(header.replace(/^Bearer /, ""));
	if (!claims) return c.json({ error: "unauthorized" }, 401);
	c.set("userId", claims.sub);
	await next();
}
`,
	"src/orders/service.ts": `import { orders } from "./store";
import { charge } from "../payments/gateway";
import { events } from "../events/bus";

export async function createOrder(userId: string, cartId: string) {
	const cart = await orders.loadCart(cartId);
	const order = await orders.insert({ userId, items: cart.items, total: cart.total, status: "pending" });
	events.publish("order.created", { orderId: order.id });
	return order;
}

export async function payOrder(orderId: string) {
	const order = await orders.get(orderId);
	const payment = await charge(order.total, order.userId);
	if (!payment.ok) return { ok: false, reason: payment.reason };
	await orders.setStatus(orderId, "paid");
	events.publish("order.paid", { orderId });
	return { ok: true };
}
`,
	"src/orders/store.ts": `import { db } from "../db";

export const orders = {
	loadCart: (id: string) => db.one("select * from carts where id = $1", [id]),
	insert: (order: NewOrder) => db.one("insert into orders (user_id, items, total, status) values (...) returning *", [order]),
	get: (id: string) => db.one("select * from orders where id = $1", [id]),
	setStatus: (id: string, status: string) => db.run("update orders set status = $2 where id = $1", [id, status]),
};
`,
	"src/orders/refunds.ts": `import { orders } from "./store";
import { refund } from "../payments/gateway";
import { events } from "../events/bus";

export async function refundOrder(orderId: string, reason: string) {
	const order = await orders.get(orderId);
	const result = await refund(order.paymentId, order.total);
	await orders.setStatus(orderId, "refunded");
	events.publish("order.refunded", { orderId, reason });
	return result;
}
`,
	"src/payments/gateway.ts": `import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_KEY!);

export async function charge(amountCents: number, customer: string) {
	try {
		const intent = await stripe.paymentIntents.create({ amount: amountCents, currency: "usd", customer, confirm: true });
		return { ok: intent.status === "succeeded", paymentId: intent.id, reason: intent.last_payment_error?.message };
	} catch (error) {
		return { ok: false, paymentId: null, reason: String(error) };
	}
}

export async function refund(paymentId: string, amountCents: number) {
	const result = await stripe.refunds.create({ payment_intent: paymentId, amount: amountCents });
	return { ok: result.status !== "failed", refundId: result.id };
}
`,
	"src/events/bus.ts": `import { queue } from "../jobs/queue";

export const events = {
	publish(topic: string, payload: unknown) {
		queue.add({ topic, payload });
	},
};
`,
	"src/jobs/worker.ts": `import { queue } from "./queue";
import { sendReceipt } from "../notifications/email";

queue.process(async job => {
	if (job.topic === "order.paid") await sendReceipt(job.payload.orderId);
});
`,
};

/** The files at the base commit: no refunds yet, and the legacy billing client still there. */
const BASE_FILES: Record<string, string> = {
	...Object.fromEntries(Object.entries(SOURCE_FILES).filter(([path]) => path !== "src/orders/refunds.ts")),
	"src/payments/gateway.ts": `${SOURCE_FILES["src/payments/gateway.ts"]!.split("\nexport async function refund")[0]}\n`,
	"src/payments/legacy.ts": `export async function chargeLegacy(amountCents: number, card: string) {
	return fetch("https://billing.example/charge", { method: "POST", body: JSON.stringify({ amountCents, card }) });
}
`,
};

function sourceOf(path: string, side: "head" | "base"): string | undefined {
	const files = side === "base" ? BASE_FILES : SOURCE_FILES;
	return Object.hasOwn(files, path) ? files[path] : undefined;
}

/** A citation of the first line of `path` holding `token`. */
function cite(path: string, token: string, side: "head" | "base" = "head"): BlueprintRef {
	const text = sourceOf(path, side);
	if (text === undefined) throw new Error(`mock blueprint: no file ${path} (${side})`);
	const index = text.split("\n").findIndex(line => line.includes(token));
	if (index === -1) throw new Error(`mock blueprint: ${path} has no "${token}" (${side})`);
	const ref: BlueprintRef = { path, line: index + 1, token };
	if (side === "base") ref.side = "base";
	return ref;
}

const LANGUAGES: Record<string, string> = { ts: "typescript", tsx: "tsx" };

function excerptOf(ref: BlueprintExcerptRef, commit: { head: string; base: string }): BlueprintExcerpt | null {
	const side = ref.side ?? "head";
	const text = sourceOf(ref.path, side);
	if (text === undefined) return null;
	const excerpt = readExcerpt(text.split("\n"), ref, side, side === "base" ? commit.base : commit.head);
	return excerpt === null ? null : { ...excerpt, language: LANGUAGES[ref.path.split(".").pop() ?? ""] };
}

type NodeSpec = Omit<BlueprintNode, "refs"> & { refs?: BlueprintRef[] };

function diagram(
	id: string,
	title: string,
	origin: "agent" | "index",
	parent: string | undefined,
	summary: string | undefined,
	nodes: NodeSpec[],
	edges: (Omit<BlueprintEdge, "id"> & { id?: string })[],
): BlueprintDiagram {
	const out: BlueprintDiagram = {
		id,
		title,
		origin,
		nodes,
		edges: edges.map(edge => ({ ...edge, id: edge.id ?? `${edge.from}>${edge.to}` })),
	};
	if (parent !== undefined) out.parent = parent;
	if (summary !== undefined) out.summary = summary;
	return out;
}

function file(path: string, summary: string, change?: BlueprintChange): NodeSpec {
	const node: NodeSpec = {
		id: `f:${path}`,
		label: path.split("/").pop()!,
		kind: "file",
		summary,
		path,
		child: `index:file:${path}`,
	};
	if (change !== undefined) node.change = change;
	return node;
}

function symbol(path: string, name: string, summary: string, change?: BlueprintChange): NodeSpec {
	const node: NodeSpec = {
		id: `s:${path}#${name}`,
		label: name,
		kind: "symbol",
		summary,
		path,
		refs: [cite(path, name)],
	};
	if (change !== undefined) node.change = change;
	return node;
}

/** The diagrams both maps share, below the agent's top ones: the code index's, with no model. */
function indexDiagrams(): BlueprintDiagram[] {
	const ordersDir = "src/orders";
	return [
		diagram(
			"index:repo",
			"All code",
			"index",
			"system",
			"7 folders, 12 files, mostly TypeScript.",
			[
				{
					id: "d:src/web",
					label: "src/web",
					kind: "package",
					summary: "2 files, 9 symbols.",
					path: "src/web",
					child: "index:dir:src/web",
				},
				{
					id: "d:src/api",
					label: "src/api",
					kind: "package",
					summary: "2 files, 6 symbols.",
					path: "src/api",
					child: "index:dir:src/api",
				},
				{
					id: "d:src/orders",
					label: "src/orders",
					kind: "package",
					summary: "3 files, 11 symbols.",
					path: "src/orders",
					child: "index:dir:src/orders",
				},
				{
					id: "d:src/payments",
					label: "src/payments",
					kind: "package",
					summary: "1 file, 4 symbols.",
					path: "src/payments",
				},
				{
					id: "d:src/events",
					label: "src/events",
					kind: "package",
					summary: "1 file, 1 symbol.",
					path: "src/events",
				},
				{ id: "d:src/jobs", label: "src/jobs", kind: "package", summary: "1 file, 2 symbols.", path: "src/jobs" },
			],
			[
				{
					from: "d:src/web",
					to: "d:src/api",
					label: "2 imports",
					kind: "import",
					refs: [cite("src/web/client.ts", "VITE_API_URL")],
				},
				{
					from: "d:src/api",
					to: "d:src/orders",
					label: "1 import",
					kind: "import",
					refs: [cite("src/api/server.ts", "../orders/service")],
				},
				{
					from: "d:src/orders",
					to: "d:src/payments",
					label: "1 import",
					kind: "import",
					refs: [cite("src/orders/service.ts", "../payments/gateway")],
				},
				{
					from: "d:src/orders",
					to: "d:src/events",
					label: "1 import",
					kind: "import",
					refs: [cite("src/orders/service.ts", "../events/bus")],
				},
				{
					from: "d:src/events",
					to: "d:src/jobs",
					label: "1 import",
					kind: "import",
					refs: [cite("src/events/bus.ts", "../jobs/queue")],
				},
			],
		),
		diagram(
			`index:dir:${ordersDir}`,
			"src/orders",
			"index",
			"orders",
			"2 files, 7 symbols, TypeScript.",
			[
				file("src/orders/service.ts", "TypeScript, 2 symbols."),
				file("src/orders/store.ts", "TypeScript, 1 symbol."),
				{
					id: "o:src/payments",
					label: "src/payments",
					kind: "package",
					summary: "Outside this folder.",
					path: "src/payments",
				},
				{
					id: "o:src/events",
					label: "src/events",
					kind: "package",
					summary: "Outside this folder.",
					path: "src/events",
				},
			],
			[
				{
					from: "f:src/orders/service.ts",
					to: "f:src/orders/store.ts",
					label: "1 import",
					kind: "import",
					refs: [cite("src/orders/service.ts", "./store")],
				},
				{
					from: "f:src/orders/service.ts",
					to: "o:src/payments",
					label: "1 import",
					kind: "import",
					refs: [cite("src/orders/service.ts", "../payments/gateway")],
				},
				{
					from: "f:src/orders/service.ts",
					to: "o:src/events",
					label: "1 import",
					kind: "import",
					refs: [cite("src/orders/service.ts", "../events/bus")],
				},
			],
		),
		diagram(
			"index:file:src/orders/service.ts",
			"src/orders/service.ts",
			"index",
			`index:dir:${ordersDir}`,
			"2 exported functions.",
			[
				symbol("src/orders/service.ts", "createOrder", "Loads the cart, inserts a pending order and announces it."),
				symbol("src/orders/service.ts", "payOrder", "Charges the customer, marks the order paid and announces it."),
				{
					id: "x:orders.insert",
					label: "orders.insert",
					kind: "symbol",
					summary: "In src/orders/store.ts.",
					path: "src/orders/store.ts",
					refs: [cite("src/orders/store.ts", "insert:")],
				},
				{
					id: "x:charge",
					label: "charge",
					kind: "symbol",
					summary: "In src/payments/gateway.ts.",
					path: "src/payments/gateway.ts",
					refs: [cite("src/payments/gateway.ts", "export async function charge")],
				},
				{
					id: "x:events.publish",
					label: "events.publish",
					kind: "symbol",
					summary: "In src/events/bus.ts.",
					path: "src/events/bus.ts",
					refs: [cite("src/events/bus.ts", "publish(")],
				},
			],
			[
				{
					from: "s:src/orders/service.ts#createOrder",
					to: "x:orders.insert",
					label: "calls",
					kind: "call",
					refs: [cite("src/orders/service.ts", "orders.insert")],
				},
				{
					from: "s:src/orders/service.ts#createOrder",
					to: "x:events.publish",
					label: "calls",
					kind: "call",
					refs: [cite("src/orders/service.ts", 'publish("order.created"')],
				},
				{
					from: "s:src/orders/service.ts#payOrder",
					to: "x:charge",
					label: "calls",
					kind: "call",
					refs: [cite("src/orders/service.ts", "await charge(")],
				},
				{
					from: "s:src/orders/service.ts#payOrder",
					to: "x:events.publish",
					label: "calls",
					kind: "call",
					refs: [cite("src/orders/service.ts", 'publish("order.paid"')],
				},
			],
		),
		diagram(
			"index:file:src/orders/store.ts",
			"src/orders/store.ts",
			"index",
			`index:dir:${ordersDir}`,
			"The order queries.",
			[
				symbol("src/orders/store.ts", "loadCart", "Reads a cart by id."),
				symbol("src/orders/store.ts", "setStatus", "Moves an order to a new status."),
				{
					id: "x:db",
					label: "db",
					kind: "store",
					summary: "The Postgres client.",
					path: "src/db.ts",
					refs: [cite("src/orders/store.ts", "../db")],
				},
			],
			[
				{
					from: "s:src/orders/store.ts#loadCart",
					to: "x:db",
					label: "queries",
					kind: "data",
					refs: [cite("src/orders/store.ts", "loadCart")],
				},
				{
					from: "s:src/orders/store.ts#setStatus",
					to: "x:db",
					label: "updates",
					kind: "data",
					refs: [cite("src/orders/store.ts", "setStatus")],
				},
			],
		),
		diagram(
			"index:dir:src/api",
			"src/api",
			"index",
			"api",
			"2 files, 6 symbols, TypeScript.",
			[
				file("src/api/server.ts", "TypeScript, 3 symbols."),
				file("src/api/auth.ts", "TypeScript, 1 symbol."),
				{
					id: "o:src/orders",
					label: "src/orders",
					kind: "package",
					summary: "Outside this folder.",
					path: "src/orders",
					child: `index:dir:${ordersDir}`,
				},
			],
			[
				{
					from: "f:src/api/server.ts",
					to: "f:src/api/auth.ts",
					label: "1 import",
					kind: "import",
					refs: [cite("src/api/server.ts", "./auth")],
				},
				{
					from: "f:src/api/server.ts",
					to: "o:src/orders",
					label: "1 import",
					kind: "import",
					refs: [cite("src/api/server.ts", "../orders/service")],
				},
			],
		),
		diagram(
			"index:dir:src/web",
			"src/web",
			"index",
			"web",
			"2 files, 4 symbols, TypeScript.",
			[file("src/web/Checkout.tsx", "TSX, 2 symbols."), file("src/web/client.ts", "TypeScript, 1 symbol.")],
			[
				{
					from: "f:src/web/Checkout.tsx",
					to: "f:src/web/client.ts",
					label: "1 import",
					kind: "import",
					refs: [cite("src/web/Checkout.tsx", "./client")],
				},
			],
		),
	];
}

function assemble(
	head: { id: string; title: string; ref: string; commit: string; subject: string },
	base: { ref: string; commit: string } | undefined,
	diagrams: BlueprintDiagram[],
	extra: Partial<Blueprint>,
): Blueprint {
	const map: Blueprint = {
		v: BLUEPRINT_VERSION,
		id: head.id,
		title: head.title,
		repo: { root: MOCK_REPO_ROOT, name: "acme-shop", github: "example/acme-shop" },
		head: { commit: head.commit, ref: head.ref, subject: head.subject },
		createdAt: Date.now() - 2 * HOUR,
		model: "anthropic/claude-sonnet-5-5",
		costUsd: 0.84,
		root: "system",
		diagrams: Object.fromEntries(diagrams.map(item => [item.id, item])),
		warnings: [],
		...extra,
	};
	if (base !== undefined) map.base = { commit: base.commit, ref: base.ref };
	return map;
}

/** A whole-repository map: the agent's system and component diagrams, then the index's folders, files and symbols. */
export function fullMap(id = "bp-main", title = "acme-shop @ main", ref = "main", commit = HEAD_COMMIT): Blueprint {
	const agentDiagrams = [
		diagram(
			"system",
			"System overview",
			"agent",
			undefined,
			"A shopper pays through the storefront. The API creates and charges orders, announces them on an event bus, and a worker sends the receipts.",
			[
				{ id: "shopper", label: "Shopper", kind: "actor", summary: "Browses and pays from the storefront." },
				{
					id: "web",
					label: "Storefront",
					kind: "ui",
					summary: "The React app: cart and checkout.",
					path: "src/web",
					child: "web",
					refs: [cite("src/web/Checkout.tsx", "export function Checkout")],
				},
				{
					id: "api",
					label: "API server",
					kind: "service",
					summary: "Hono routes behind bearer-token auth.",
					path: "src/api",
					child: "api",
					refs: [cite("src/api/server.ts", "export const app")],
				},
				{
					id: "orders",
					label: "Orders",
					kind: "component",
					summary: "Creating, paying and storing orders.",
					path: "src/orders",
					child: "orders",
					refs: [cite("src/orders/service.ts", "export async function createOrder")],
				},
				{
					id: "payments",
					label: "Payments",
					kind: "component",
					summary: "The Stripe gateway.",
					path: "src/payments",
					child: "payments",
					refs: [cite("src/payments/gateway.ts", "export async function charge")],
				},
				{
					id: "bus",
					label: "Event bus",
					kind: "queue",
					summary: "Order events, delivered by the job queue.",
					path: "src/events",
					refs: [cite("src/events/bus.ts", "export const events")],
				},
				{
					id: "worker",
					label: "Job worker",
					kind: "service",
					summary: "Sends receipts for paid orders.",
					path: "src/jobs",
					refs: [cite("src/jobs/worker.ts", "queue.process")],
				},
				{
					id: "db",
					label: "Postgres",
					kind: "store",
					summary: "Carts and orders.",
					refs: [cite("src/orders/store.ts", "../db")],
				},
				{
					id: "stripe",
					label: "Stripe",
					kind: "external",
					summary: "Card payments.",
					refs: [cite("src/payments/gateway.ts", "new Stripe")],
				},
				{
					id: "all-code",
					label: "All code",
					kind: "module",
					summary: "Every folder of the repository, from the code index, with the imports between them.",
					child: "index:repo",
				},
			],
			[
				{
					from: "shopper",
					to: "web",
					label: "pays",
					kind: "http",
					refs: [cite("src/web/Checkout.tsx", "Pay now")],
				},
				{
					from: "web",
					to: "api",
					label: "POST /orders",
					kind: "http",
					refs: [cite("src/web/client.ts", "fetch(")],
				},
				{
					from: "api",
					to: "orders",
					label: "createOrder, payOrder",
					kind: "call",
					refs: [cite("src/api/server.ts", "createOrder("), cite("src/api/server.ts", "payOrder(")],
				},
				{
					from: "orders",
					to: "payments",
					label: "charge",
					kind: "call",
					refs: [cite("src/orders/service.ts", "await charge(")],
				},
				{
					from: "payments",
					to: "stripe",
					label: "payment intents",
					kind: "http",
					refs: [cite("src/payments/gateway.ts", "paymentIntents.create")],
				},
				{
					from: "orders",
					to: "db",
					label: "reads and writes orders",
					kind: "data",
					refs: [cite("src/orders/store.ts", "db.one")],
				},
				{
					from: "orders",
					to: "bus",
					label: "order.created, order.paid",
					kind: "event",
					refs: [cite("src/orders/service.ts", "events.publish")],
				},
				{
					from: "bus",
					to: "worker",
					label: "delivers",
					kind: "event",
					refs: [cite("src/events/bus.ts", "queue.add")],
				},
				{
					from: "worker",
					to: "shopper",
					label: "receipt email",
					kind: "event",
					refs: [cite("src/jobs/worker.ts", "sendReceipt")],
				},
			],
		),
		diagram(
			"web",
			"Storefront",
			"agent",
			"system",
			"Checkout creates the order, then pays it.",
			[
				{
					id: "checkout",
					label: "Checkout",
					kind: "ui",
					summary: "The pay button and its status.",
					path: "src/web/Checkout.tsx",
					refs: [cite("src/web/Checkout.tsx", "async function pay")],
				},
				{
					id: "cart",
					label: "CartSummary",
					kind: "ui",
					summary: "Lists the cart.",
					path: "src/web/CartSummary.tsx",
				},
				{
					id: "client",
					label: "API client",
					kind: "module",
					summary: "A fetch wrapper that adds the bearer token.",
					path: "src/web/client.ts",
					child: "index:dir:src/web",
					refs: [cite("src/web/client.ts", "export const api")],
				},
				{
					id: "api",
					label: "API server",
					kind: "service",
					summary: "Across the network.",
					child: "api",
					path: "src/api",
				},
			],
			[
				{
					from: "checkout",
					to: "cart",
					label: "renders",
					kind: "call",
					refs: [cite("src/web/Checkout.tsx", "<CartSummary")],
				},
				{
					from: "checkout",
					to: "client",
					label: "api.post",
					kind: "call",
					refs: [cite("src/web/Checkout.tsx", 'api.post("/orders"')],
				},
				{
					from: "client",
					to: "api",
					label: "fetch",
					kind: "http",
					refs: [cite("src/web/client.ts", "await fetch(")],
				},
			],
		),
		diagram(
			"api",
			"API server",
			"agent",
			"system",
			"Two routes, behind bearer-token auth.",
			[
				{
					id: "routes",
					label: "Routes",
					kind: "module",
					summary: "POST /orders and POST /orders/:id/pay.",
					path: "src/api/server.ts",
					child: "index:dir:src/api",
					refs: [cite("src/api/server.ts", 'app.post("/orders"')],
				},
				{
					id: "auth",
					label: "requireAuth",
					kind: "module",
					summary: "Verifies the bearer token and sets the user.",
					path: "src/api/auth.ts",
					refs: [cite("src/api/auth.ts", "export async function requireAuth")],
				},
				{
					id: "orders",
					label: "Orders",
					kind: "component",
					summary: "The order service.",
					child: "orders",
					path: "src/orders",
				},
			],
			[
				{
					from: "routes",
					to: "auth",
					label: "app.use",
					kind: "call",
					refs: [cite("src/api/server.ts", "app.use(")],
				},
				{
					from: "routes",
					to: "orders",
					label: "createOrder, payOrder",
					kind: "call",
					refs: [cite("src/api/server.ts", "await createOrder(")],
				},
			],
		),
		diagram(
			"orders",
			"Orders",
			"agent",
			"system",
			"The service reads and writes orders through the store, charges through payments and announces what happened.",
			[
				{
					id: "service",
					label: "Order service",
					kind: "module",
					summary: "createOrder and payOrder.",
					path: "src/orders/service.ts",
					child: "index:file:src/orders/service.ts",
					refs: [cite("src/orders/service.ts", "export async function payOrder")],
				},
				{
					id: "store",
					label: "Order store",
					kind: "module",
					summary: "SQL for carts and orders.",
					path: "src/orders/store.ts",
					child: "index:file:src/orders/store.ts",
					refs: [cite("src/orders/store.ts", "export const orders")],
				},
				{
					id: "files",
					label: "All order files",
					kind: "package",
					summary: "The folder's files and their imports, from the code index.",
					path: "src/orders",
					child: "index:dir:src/orders",
				},
				{
					id: "payments",
					label: "Payments",
					kind: "component",
					summary: "Charges the customer.",
					child: "payments",
					path: "src/payments",
				},
				{ id: "db", label: "Postgres", kind: "store", summary: "Carts and orders." },
			],
			[
				{
					from: "service",
					to: "store",
					label: "orders.*",
					kind: "call",
					refs: [cite("src/orders/service.ts", "./store")],
				},
				{
					from: "service",
					to: "payments",
					label: "charge",
					kind: "call",
					refs: [cite("src/orders/service.ts", "await charge(")],
				},
				{
					from: "store",
					to: "db",
					label: "SQL",
					kind: "data",
					refs: [cite("src/orders/store.ts", 'db.one("select * from orders')],
				},
			],
		),
		diagram(
			"payments",
			"Payments",
			"agent",
			"system",
			"One gateway over Stripe.",
			[
				{
					id: "gateway",
					label: "charge",
					kind: "module",
					summary: "Creates and confirms a payment intent; never throws.",
					path: "src/payments/gateway.ts",
					refs: [cite("src/payments/gateway.ts", "export async function charge")],
				},
				{
					id: "stripe",
					label: "Stripe",
					kind: "external",
					summary: "Card payments.",
					refs: [cite("src/payments/gateway.ts", "import Stripe")],
				},
			],
			[
				{
					from: "gateway",
					to: "stripe",
					label: "paymentIntents.create",
					kind: "http",
					refs: [cite("src/payments/gateway.ts", "paymentIntents.create")],
				},
			],
		),
	];
	return assemble(
		{ id, title, ref, commit, subject: "Retry the receipt job on a transient mail error" },
		undefined,
		[...agentDiagrams, ...indexDiagrams()],
		{
			warnings: [
				"Dropped 1 citation: src/jobs/worker.ts line 40 (token “retry”) is not at this commit.",
				"The agent named a folder, src/notifications, that holds no files at this commit; its node has no code.",
			],
		},
	);
}

/** "feature/refunds" against "main": refunds added, the charge path touched, the legacy billing client removed. */
export function changesMap(id = "bp-refunds", title = "feature/refunds vs main"): Blueprint {
	const refundBase = cite("src/payments/legacy.ts", "chargeLegacy", "base");
	const diagrams = [
		diagram(
			"system",
			"System overview",
			"agent",
			undefined,
			"Refunds are new: the orders service gets a refund path through the payments gateway, and the legacy billing client is gone.",
			[
				{
					id: "api",
					label: "API server",
					kind: "service",
					summary: "Unchanged; the refund route is not exposed yet.",
					path: "src/api",
					refs: [cite("src/api/server.ts", "export const app")],
				},
				{
					id: "orders",
					label: "Orders",
					kind: "component",
					change: "modified",
					summary: "Gains refundOrder next to createOrder and payOrder.",
					path: "src/orders",
					child: "orders",
					refs: [cite("src/orders/service.ts", "export async function payOrder")],
				},
				{
					id: "refunds",
					label: "Refunds",
					kind: "component",
					change: "added",
					summary: "Refunds a paid order and announces it.",
					path: "src/orders/refunds.ts",
					child: "index:file:src/orders/refunds.ts",
					refs: [cite("src/orders/refunds.ts", "export async function refundOrder")],
				},
				{
					id: "payments",
					label: "Payments",
					kind: "component",
					change: "modified",
					summary: "Gains refund; charge now also returns the payment id.",
					path: "src/payments",
					child: "payments",
					refs: [cite("src/payments/gateway.ts", "export async function refund")],
				},
				{
					id: "legacy",
					label: "Legacy billing",
					kind: "module",
					change: "removed",
					summary: "The old billing client; nothing called it any more.",
					path: "src/payments/legacy.ts",
					refs: [refundBase],
				},
				{
					id: "stripe",
					label: "Stripe",
					kind: "external",
					summary: "Card payments.",
					refs: [cite("src/payments/gateway.ts", "new Stripe")],
				},
				{
					id: "bus",
					label: "Event bus",
					kind: "queue",
					summary: "Carries order.refunded now.",
					change: "modified",
					path: "src/events",
					refs: [cite("src/events/bus.ts", "export const events")],
				},
			],
			[
				{
					from: "api",
					to: "orders",
					label: "createOrder, payOrder",
					kind: "call",
					refs: [cite("src/api/server.ts", "await createOrder(")],
				},
				{
					from: "orders",
					to: "refunds",
					label: "refundOrder",
					kind: "call",
					change: "added",
					refs: [cite("src/orders/refunds.ts", "export async function refundOrder")],
				},
				{
					from: "refunds",
					to: "payments",
					label: "refund",
					kind: "call",
					change: "added",
					refs: [cite("src/orders/refunds.ts", "await refund(")],
				},
				{
					from: "orders",
					to: "payments",
					label: "charge",
					kind: "call",
					change: "modified",
					refs: [cite("src/orders/service.ts", "await charge(")],
				},
				{
					from: "payments",
					to: "stripe",
					label: "payment intents, refunds",
					kind: "http",
					change: "modified",
					refs: [cite("src/payments/gateway.ts", "refunds.create")],
				},
				{
					from: "refunds",
					to: "bus",
					label: "order.refunded",
					kind: "event",
					change: "added",
					refs: [cite("src/orders/refunds.ts", "order.refunded")],
				},
				{
					from: "payments",
					to: "legacy",
					label: "chargeLegacy",
					kind: "call",
					change: "removed",
					refs: [refundBase],
				},
			],
		),
		diagram(
			"orders",
			"Orders",
			"agent",
			"system",
			"What changed in src/orders.",
			[
				{
					id: "service",
					label: "Order service",
					kind: "module",
					change: "modified",
					summary: "payOrder reads paymentId from the charge result.",
					path: "src/orders/service.ts",
					child: "index:file:src/orders/service.ts",
					refs: [cite("src/orders/service.ts", "export async function payOrder")],
				},
				{
					id: "refunds",
					label: "Refunds",
					kind: "module",
					change: "added",
					summary: "refundOrder.",
					path: "src/orders/refunds.ts",
					child: "index:file:src/orders/refunds.ts",
					refs: [cite("src/orders/refunds.ts", "export async function refundOrder")],
				},
				{
					id: "store",
					label: "Order store",
					kind: "module",
					summary: "Unchanged; shown for context.",
					path: "src/orders/store.ts",
					refs: [cite("src/orders/store.ts", "export const orders")],
				},
			],
			[
				{
					from: "refunds",
					to: "store",
					label: "orders.get, setStatus",
					kind: "call",
					change: "added",
					refs: [cite("src/orders/refunds.ts", "orders.setStatus")],
				},
				{
					from: "service",
					to: "store",
					label: "orders.*",
					kind: "call",
					refs: [cite("src/orders/service.ts", "./store")],
				},
			],
		),
		diagram(
			"payments",
			"Payments",
			"agent",
			"system",
			"charge returns the payment id; refund is new.",
			[
				{
					id: "charge",
					label: "charge",
					kind: "module",
					change: "modified",
					summary: "Also returns paymentId so a payment can be refunded.",
					path: "src/payments/gateway.ts",
					refs: [cite("src/payments/gateway.ts", "paymentId: intent.id")],
				},
				{
					id: "refund",
					label: "refund",
					kind: "module",
					change: "added",
					summary: "Refunds a payment intent.",
					path: "src/payments/gateway.ts",
					refs: [cite("src/payments/gateway.ts", "export async function refund")],
				},
				{ id: "stripe", label: "Stripe", kind: "external", summary: "Card payments." },
			],
			[
				{
					from: "charge",
					to: "stripe",
					label: "paymentIntents.create",
					kind: "http",
					refs: [cite("src/payments/gateway.ts", "paymentIntents.create")],
				},
				{
					from: "refund",
					to: "stripe",
					label: "refunds.create",
					kind: "http",
					change: "added",
					refs: [cite("src/payments/gateway.ts", "refunds.create")],
				},
			],
		),
		diagram(
			"index:file:src/orders/refunds.ts",
			"src/orders/refunds.ts",
			"index",
			"orders",
			"New file: 1 exported function.",
			[
				symbol(
					"src/orders/refunds.ts",
					"refundOrder",
					"Refunds the payment, marks the order refunded and announces it.",
					"added",
				),
				{
					id: "x:refund",
					label: "refund",
					kind: "symbol",
					summary: "In src/payments/gateway.ts.",
					path: "src/payments/gateway.ts",
					change: "added",
					refs: [cite("src/payments/gateway.ts", "export async function refund")],
				},
				{
					id: "x:events.publish",
					label: "events.publish",
					kind: "symbol",
					summary: "In src/events/bus.ts.",
					path: "src/events/bus.ts",
					refs: [cite("src/events/bus.ts", "publish(")],
				},
			],
			[
				{
					from: "s:src/orders/refunds.ts#refundOrder",
					to: "x:refund",
					label: "calls",
					kind: "call",
					change: "added",
					refs: [cite("src/orders/refunds.ts", "await refund(")],
				},
				{
					from: "s:src/orders/refunds.ts#refundOrder",
					to: "x:events.publish",
					label: "calls",
					kind: "call",
					change: "added",
					refs: [cite("src/orders/refunds.ts", "events.publish")],
				},
			],
		),
		diagram(
			"index:file:src/orders/service.ts",
			"src/orders/service.ts",
			"index",
			"orders",
			"2 exported functions; payOrder changed.",
			[
				symbol("src/orders/service.ts", "createOrder", "Unchanged."),
				symbol("src/orders/service.ts", "payOrder", "Reads the payment id from the charge result.", "modified"),
				{
					id: "x:charge",
					label: "charge",
					kind: "symbol",
					summary: "In src/payments/gateway.ts.",
					path: "src/payments/gateway.ts",
					change: "modified",
					refs: [cite("src/payments/gateway.ts", "export async function charge")],
				},
			],
			[
				{
					from: "s:src/orders/service.ts#payOrder",
					to: "x:charge",
					label: "calls",
					kind: "call",
					refs: [cite("src/orders/service.ts", "await charge(")],
				},
			],
		),
	];
	return assemble(
		{
			id,
			title,
			ref: "feature/refunds",
			commit: HEAD_COMMIT,
			subject: "Refund an order through the payments gateway",
		},
		{ ref: "main", commit: BASE_COMMIT },
		diagrams,
		{
			createdAt: Date.now() - 26 * 60 * 1000,
			costUsd: 0.51,
			warnings: ["Compared with the merge base of main and feature/refunds (5be29d0), not main's tip."],
		},
	);
}

const STAGES = [
	"Reading the repository",
	"Writing the system diagram",
	"Writing the component diagrams (2 of 4)",
	"Writing the component diagrams (4 of 4)",
	"Checking every citation against the commit",
	"Building the file and symbol diagrams",
];
const TICK_MS = 2500;

export interface MockBlueprint {
	/** Fields the mock companion's `hosts` frame needs for the app to offer architecture maps. */
	capabilities: { canBlueprint: true };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): CompanionReply;
}

export function createMockBlueprint(options: {
	/** A map was added, changed or removed: pushed to every guest as `blueprint-changed`. */
	onChanged(id: string): void;
	/** The omp session that a running map is written by, so the app can offer to watch it. */
	instanceId: string;
	/** Maps written by the real pipeline, loaded from JSON; their code is read from `sourceDir` when given. */
	samples?: { file: string; sourceDir?: string }[];
}): MockBlueprint {
	const now = Date.now();
	const summaries: BlueprintSummary[] = [];
	const bodies = new Map<string, Blueprint>();
	let counter = 0;
	/** Maps loaded from a file, whose cited code is read from a checkout instead of the embedded sources. */
	const sampleDirs = new Map<string, string>();

	const store = (map: Blueprint, over: Partial<BlueprintSummary> = {}): BlueprintSummary => {
		bodies.set(map.id, map);
		const summary: BlueprintSummary = {
			id: map.id,
			title: map.title,
			repoRoot: map.repo.root,
			head: map.head,
			createdAt: map.createdAt,
			status: "ready",
			diagramCount: Object.keys(map.diagrams).length,
			costUsd: map.costUsd,
			...over,
		};
		if (map.base !== undefined) summary.base = map.base;
		summaries.push(summary);
		return summary;
	};

	for (const sample of options.samples ?? []) {
		const map = JSON.parse(fs.readFileSync(sample.file, "utf8")) as Blueprint;
		map.id = `bp-sample-${sampleDirs.size + 1}`;
		store(map);
		if (sample.sourceDir !== undefined) sampleDirs.set(map.id, sample.sourceDir);
	}

	const main = fullMap();
	main.createdAt = now - 2 * HOUR;
	store(main);
	store(changesMap());
	const stale = fullMap("bp-release", "acme-shop @ release/2.4", "release/2.4", MOVED_COMMIT);
	stale.createdAt = now - 3 * 24 * HOUR;
	stale.costUsd = 1.12;
	store(stale, { stale: true });
	summaries.push({
		id: "bp-failed",
		title: "pr/482 Add refunds to the orders service",
		repoRoot: MOCK_REPO_ROOT,
		head: { commit: HEAD_COMMIT, ref: "pr/482" },
		base: { commit: BASE_COMMIT, ref: "main" },
		createdAt: now - 5 * HOUR,
		status: "failed",
		error: "Stopped at the $1.00 cost limit before the system diagram was done.",
		costUsd: 1,
	});

	/** Tick a map through its stages, pushing each, then finish it as `finished`. */
	const run = (summary: BlueprintSummary, finished: () => Blueprint): void => {
		let stage = 0;
		summary.status = "running";
		summary.instanceId = options.instanceId;
		summary.progress = STAGES[0];
		options.onChanged(summary.id);
		const timer = setInterval(() => {
			stage++;
			if (stage < STAGES.length) {
				summary.progress = STAGES[stage];
				options.onChanged(summary.id);
				return;
			}
			clearInterval(timer);
			const map = finished();
			bodies.set(map.id, map);
			Object.assign(summary, {
				status: "ready",
				stale: undefined,
				progress: undefined,
				instanceId: undefined,
				title: map.title,
				head: map.head,
				createdAt: map.createdAt,
				diagramCount: Object.keys(map.diagrams).length,
				costUsd: map.costUsd,
			});
			options.onChanged(summary.id);
		}, TICK_MS);
	};

	const refs = (q: string | undefined): BlueprintRefsAnswer => {
		const match = (text: string): boolean =>
			q === undefined || q === "" || text.toLowerCase().includes(q.toLowerCase());
		return {
			branches: ["main", "feature/refunds", "fix/checkout-race", "release/2.4", "chore/deps"].filter(match),
			current: "feature/refunds",
			prs: [
				{ number: 482, title: "Add refunds to the orders service", head: "feature/refunds", base: "main" },
				{ number: 479, title: "Fix the double charge on a slow checkout", head: "fix/checkout-race", base: "main" },
				{ number: 471, title: "Bump Stripe to the latest API version", head: "chore/deps", base: "main" },
			].filter(pr => match(`${pr.number} ${pr.title} ${pr.head}`)),
		};
	};

	return {
		capabilities: { canBlueprint: true },
		handles: request => request.t.startsWith("blueprint-"),
		answer(request): CompanionReply {
			switch (request.t) {
				case "blueprint-list":
					return { t: "blueprint-list", reqId: request.reqId, maps: summaries.map(summary => ({ ...summary })) };
				case "blueprint-create": {
					const created = `bp-new-${++counter}`;
					const refreshing =
						request.refresh === undefined ? undefined : summaries.find(s => s.id === request.refresh);
					const ref = request.ref ?? "main";
					const compared = request.base !== undefined;
					const pr = /^pr\/(\d+)$/.exec(ref);
					const label = ref === "@worktree" ? "uncommitted work" : pr ? `pull request #${pr[1]}` : ref;
					const title = `acme-shop ${compared || pr ? `${label} vs ${request.base ?? "main"}` : `@ ${label}`}`;
					const summary: BlueprintSummary = refreshing ?? {
						id: created,
						title,
						repoRoot: MOCK_REPO_ROOT,
						head: { commit: HEAD_COMMIT, ref },
						createdAt: Date.now(),
						status: "running",
					};
					if (refreshing === undefined) {
						if (compared || pr) summary.base = { commit: BASE_COMMIT, ref: request.base ?? "main" };
						summaries.unshift(summary);
					}
					const finish = (): Blueprint => {
						const map =
							summary.base === undefined
								? fullMap(summary.id, summary.title, ref, HEAD_COMMIT)
								: changesMap(summary.id, summary.title);
						map.createdAt = Date.now();
						return map;
					};
					run(summary, finish);
					return { t: "blueprint-create", reqId: request.reqId, id: summary.id };
				}
				case "blueprint-get": {
					const map = bodies.get(request.id);
					if (map === undefined) throw new Error(`no map ${request.id}`);
					return { t: "blueprint-get", reqId: request.reqId, map };
				}
				case "blueprint-excerpt": {
					const map = bodies.get(request.id);
					if (map === undefined) throw new Error(`no map ${request.id}`);
					const commit = { head: map.head.commit, base: map.base?.commit ?? BASE_COMMIT };
					return {
						t: "blueprint-excerpt",
						reqId: request.reqId,
						excerpts: request.refs.map(ref => {
							const dir = sampleDirs.get(map.id);
							return dir === undefined ? excerptOf(ref, commit) : excerptFromDir(dir, ref, commit.head);
						}),
					};
				}
				case "blueprint-delete": {
					const at = summaries.findIndex(summary => summary.id === request.id);
					if (at !== -1) summaries.splice(at, 1);
					bodies.delete(request.id);
					options.onChanged(request.id);
					return { t: "blueprint-delete", reqId: request.reqId };
				}
				case "blueprint-refs":
					return { t: "blueprint-refs", reqId: request.reqId, ...refs(request.q) };
				default:
					throw new Error(`the mock companion does not answer ${request.t}`);
			}
		},
	};
}
