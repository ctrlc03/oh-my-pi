/**
 * Row shapes and SQL fragments shared by the codemap read side: the trace
 * queries in `query.ts` and the cross-language bridge derivations in
 * `bridges.ts` select the same joined symbol/reference rows.
 */

export const SIGNATURE_CHARS = 140;

/** A symbol joined with its file path and the symbol directly enclosing it. */
export interface SymbolRow {
	id: number;
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	signature: string;
	doc: string | null;
	parentId: number | null;
	implTrait: string | null;
	implFor: string | null;
	path: string;
	parentName: string | null;
	parentKind: string | null;
	parentTrait: string | null;
}

/** A reference joined with the symbol enclosing it (null columns for file-level code). */
export interface RefRow {
	refName: string;
	refKind: string;
	refLine: number;
	refCallee: string | null;
	refPath: string;
	sid: number | null;
	sname: string | null;
	skind: string | null;
	sstart: number | null;
	send: number | null;
	ssig: string | null;
	sdoc: string | null;
	pname: string | null;
	pkind: string | null;
	ptrait: string | null;
}

/** References grouped by the symbol enclosing them, with the lines and callees seen. */
export interface RefGroup {
	row: RefRow;
	lines: number[];
	callees: string[];
}

export const SYMBOL_SELECT = `SELECT s.id, s.name, s.kind, s.start_line AS startLine, s.end_line AS endLine, s.signature, s.doc,
	s.parent_id AS parentId, s.impl_trait AS implTrait, s.impl_for AS implFor, f.path,
	p.name AS parentName, p.kind AS parentKind, p.impl_trait AS parentTrait
FROM symbols s JOIN files f ON f.id = s.file_id LEFT JOIN symbols p ON p.id = s.parent_id`;

export const REF_SELECT = `SELECT r.name AS refName, r.kind AS refKind, r.line AS refLine, r.callee AS refCallee, f.path AS refPath,
	s.id AS sid, s.name AS sname, s.kind AS skind, s.start_line AS sstart, s.end_line AS send, s.signature AS ssig,
	s.doc AS sdoc, p.name AS pname, p.kind AS pkind, p.impl_trait AS ptrait
FROM refs r JOIN files f ON f.id = r.file_id
LEFT JOIN symbols s ON s.id = r.scope_symbol_id LEFT JOIN symbols p ON p.id = s.parent_id`;

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function firstSentence(doc: string | null): string | undefined {
	if (!doc) return undefined;
	const flat = doc.replace(/\s+/g, " ").trim();
	const end = flat.search(/[.!?](\s|$)/);
	return flat ? truncate(end === -1 ? flat : flat.slice(0, end + 1), SIGNATURE_CHARS) : undefined;
}

export function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

/** Group ref rows by enclosing symbol (file-scope refs stay separate by line), keeping ref lines and callees. */
export function groupByScope(rows: RefRow[]): RefGroup[] {
	const groups = new Map<string, RefGroup>();
	for (const row of rows) {
		const key = row.sid === null ? `${row.refPath}:${row.refLine}` : String(row.sid);
		let group = groups.get(key);
		if (!group) {
			group = { row, lines: [], callees: [] };
			groups.set(key, group);
		}
		group.lines.push(row.refLine);
		if (row.refCallee && !group.callees.includes(row.refCallee)) group.callees.push(row.refCallee);
	}
	return [...groups.values()];
}

/** Directory segments and file-name affixes that mark a path as test or fixture code (`Attestation` is not one). */
const TEST_PATH_RE =
	/(^|\/)(tests?|__tests__|fixtures)(\/|$)|(^|\/)tests?\.[a-z]+$|[._-]tests?\.[a-z]+$|\.spec\.[a-z]+$|\.t\.sol$/;

/** Whether the root-relative `rel` is test or fixture code. */
export function isTestPath(rel: string): boolean {
	return TEST_PATH_RE.test(rel);
}

/** SQL boolean equivalent of {@link isTestPath} over the path `column` (LIKE, so only the most common shapes); sort key for "tests last". */
export function testPathSql(column: string): string {
	const p = `('/' || ${column})`;
	return `(${p} LIKE '%/test/%' OR ${p} LIKE '%/tests/%' OR ${p} LIKE '%/__tests__/%' OR ${p} LIKE '%/fixtures/%'
		OR ${p} LIKE '%/test.%' OR ${p} LIKE '%/tests.%' OR ${column} LIKE '%.test.%' OR ${column} LIKE '%.spec.%'
		OR ${column} LIKE '%\\_test.%' ESCAPE '\\' OR ${column} LIKE '%\\_tests.%' ESCAPE '\\' OR ${column} LIKE '%-test.%' OR ${column} LIKE '%.t.sol')`;
}
