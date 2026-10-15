import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiskNote } from "../src/components/shell/DiskNote";
import { fmtAge, fmtGb } from "../src/lib/format";

describe("DiskNote", () => {
	it("shows nothing without a warning: every disk has room, or the companion predates the guard", () => {
		expect(renderToStaticMarkup(<DiskNote disk={null} />)).toBe("");
	});

	it("says how much is free and what the limit is, and turns red under 10 GB", () => {
		const warn = renderToStaticMarkup(<DiskNote disk={{ path: "/w", freeBytes: 30_000_000_000, limitBytes: 40_000_000_000 }} />);
		expect(warn).toContain("30 GB free, limit 40 GB");
		expect(warn).toContain('role="status"');
		expect(warn).not.toContain("sh-power-low");
		const red = renderToStaticMarkup(<DiskNote disk={{ path: "/w", freeBytes: 4_400_000_000, limitBytes: 40_000_000_000 }} />);
		expect(red).toContain("4.4 GB free");
		expect(red).toContain("sh-power-low");
	});
});

describe("disk formatting", () => {
	it("writes sizes the way Finder does", () => {
		expect(fmtGb(0)).toBe("0 MB");
		expect(fmtGb(812_000_000)).toBe("812 MB");
		expect(fmtGb(4_400_000_000)).toBe("4.4 GB");
		expect(fmtGb(89_000_000_000)).toBe("89 GB");
		expect(fmtGb(1_200_000_000_000)).toBe("1.2 TB");
		expect(fmtGb(-1)).toBe("0 MB");
	});

	it("writes how long a worktree sat idle", () => {
		expect(fmtAge(10_000)).toBe("under a minute");
		expect(fmtAge(12 * 60_000)).toBe("12 min");
		expect(fmtAge(3 * 3_600_000)).toBe("3 h");
		expect(fmtAge(49 * 3_600_000)).toBe("2 days");
	});
});
