/**
 * The conversation of the mock "No project" session (`mock-host.ts --topic`): a short talk about computing statistics
 * on encrypted data with fully homomorphic encryption. ./mock-quiz cites these messages from the questions of its topic
 * quizzes, so the entry ids here are the ids a question's *Show in session* jump scrolls to.
 */
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-wire";

export const TOPIC_SESSION_ID = "mock-topic-session";
/** A folder like the ones the companion makes for a session without a project: `<config>/scratch/<date>-<words>-<id>`. */
export const TOPIC_CWD = "/work/config/scratch/2026-10-14-fhe-statistics-ab12cd";

const MIN = 60_000;

interface TopicTurn {
	id: string;
	role: "user" | "assistant";
	text: string;
}

const TURNS: TopicTurn[] = [
	{
		id: "t01",
		role: "user",
		text: "I need the mean and variance of a salary column without the server ever seeing a salary. I was going to use fully homomorphic encryption. Which scheme fits, and what do I have to watch out for?",
	},
	{
		id: "t02",
		role: "assistant",
		text: "There are two families to choose from. BFV computes exactly on integers modulo a number, so every result is exact, but a salary with cents has to be scaled to whole numbers first. CKKS computes approximately on real numbers: every result carries a small error, much like floating point does. Whatever you pick, each ciphertext carries noise that grows with every operation, and multiplications grow it far faster than additions. The noise budget is how much of that growth you can afford before decryption returns garbage. In CKKS you also track a scale: multiplying two ciphertexts squares the scale, and a rescale step drops one prime from the modulus chain to bring it back, which uses up one level.",
	},
	{
		id: "t03",
		role: "user",
		text: "Salaries have cents and I only need the mean to a couple of decimals. Can I accept a tiny error if it makes this cheaper?",
	},
	{
		id: "t04",
		role: "assistant",
		text: "Yes, and that is the case for CKKS. An error around one part in a million is far below a cent, while BFV would need the cents scaled into large integers and a larger plaintext modulus to hold the sums. So I will use CKKS with a scale of 2^40 and a chain of four primes (60, 40, 40 and 60 bits). Variance needs one multiplication, so it needs one level of the chain; the second level is headroom.",
	},
	{
		id: "t05",
		role: "user",
		text: "Should the server divide the sum by the number of rows, so the client gets the mean directly?",
	},
	{
		id: "t06",
		role: "assistant",
		text: "I would not. Dividing by n is a multiplication by 1/n, which spends a level, and n is not a secret anyway. The server returns the encrypted sum and the encrypted sum of squares, and the client decrypts both and divides by n. That keeps the chain short, which lets us use a ring dimension of 8192 instead of 16384: ciphertexts are half the size and every operation is faster, at the cost of fewer slots to batch (4096 salaries per ciphertext), so a bigger table needs several ciphertexts.",
	},
	{ id: "t07", role: "user", text: "Good. Write it, with the design notes next to it." },
	{
		id: "t08",
		role: "assistant",
		text: "Done. notes/design.md records the choices above, and src/stats.py has make_context, encrypt_column and encrypted_stats. The variance comes from the mean of the squares minus the square of the mean, computed on the client after decryption, so the server only ever multiplies once.",
	},
];

/** The text of a message of the conversation, with its author; undefined for an id the conversation does not have. */
export function topicMessage(id: string): { role: "user" | "assistant"; text: string } | undefined {
	const turn = TURNS.find(item => item.id === id);
	return turn === undefined ? undefined : { role: turn.role, text: turn.text };
}

export function topicHeader(): SessionHeader {
	return {
		type: "session",
		id: TOPIC_SESSION_ID,
		title: "FHE statistics",
		timestamp: new Date(Date.now() - 40 * MIN).toISOString(),
		cwd: TOPIC_CWD,
	};
}

export function topicEntries(): SessionEntry[] {
	const start = Date.now() - 38 * MIN;
	return TURNS.map((turn, at): SessionEntry => {
		const timestamp = start + at * 2 * MIN;
		const parentId = at === 0 ? null : (TURNS[at - 1]?.id ?? null);
		if (turn.role === "user")
			return {
				id: turn.id,
				parentId,
				timestamp: new Date(timestamp).toISOString(),
				type: "message",
				message: { role: "user", content: turn.text, timestamp },
			};
		return {
			id: turn.id,
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: turn.text }],
				model: "claude-haiku-4-5",
				usage: {
					input: 900,
					output: 240,
					cacheRead: 4_000,
					cacheWrite: 0,
					totalTokens: 5_140,
					cost: { total: 0.004 },
				},
				stopReason: "stop",
				timestamp,
			},
		};
	});
}
