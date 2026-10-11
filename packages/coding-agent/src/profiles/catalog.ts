/**
 * Profile catalog: built-ins, user and project markdown files, and `profiles.<name>` settings,
 * merged by name. Later sources win: built-in, `~/.omp/agent/profiles/*.md`, settings,
 * `.omp/profiles/*.md`. A project file cannot shadow a built-in name, so a repository cannot turn
 * `build` or `review` into something looser than the user expects.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import type { Settings } from "../config/settings";
import {
	BUILTIN_PROFILES,
	type ParsedProfile,
	type ProfileDefinition,
	type ProfileSource,
	parseProfile,
} from "./definition";
import { cfgProfiles } from "./settings";

const PROFILE_CONFIG_SOURCE = ".omp";

export interface ProfileCatalog {
	/** Built-ins first, then others in discovery order; unique by case-insensitive name. */
	profiles: ProfileDefinition[];
	warnings: string[];
}

function readProfileDir(dir: string | undefined, source: ProfileSource): ParsedProfile[] {
	if (!dir) return [];
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter(file => file.endsWith(".md"));
	} catch {
		return [];
	}
	files.sort();
	return files.map(file => {
		const filePath = path.join(dir, file);
		try {
			const { frontmatter, body } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"), {
				location: filePath,
				level: "off",
			});
			const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : path.basename(file, ".md");
			return parseProfile(name, frontmatter, source, { filePath, body });
		} catch (err) {
			return { profile: undefined, warnings: [`${filePath}: ${err instanceof Error ? err.message : String(err)}`] };
		}
	});
}

/** Reads every profile source. Cheap enough to call per `/profile` or collab join. */
export function loadProfileCatalog(settings: Settings, cwd: string): ProfileCatalog {
	const warnings: string[] = [];
	const byName = new Map<string, ProfileDefinition>();
	for (const profile of BUILTIN_PROFILES) byName.set(profile.name.toLowerCase(), profile);

	const add = (parsed: ParsedProfile, protectBuiltins: boolean): void => {
		warnings.push(...parsed.warnings);
		const profile = parsed.profile;
		if (!profile) return;
		const key = profile.name.toLowerCase();
		if (protectBuiltins && BUILTIN_PROFILES.some(builtin => builtin.name.toLowerCase() === key)) {
			warnings.push(
				`${profile.filePath ?? profile.name}: a project profile cannot replace the built-in "${profile.name}"`,
			);
			return;
		}
		byName.set(key, profile);
	};

	const userDir = getConfigDirs("profiles", { project: false }).find(entry => entry.source === PROFILE_CONFIG_SOURCE);
	for (const parsed of readProfileDir(userDir?.path, "user")) add(parsed, false);

	for (const [name, raw] of Object.entries(cfgProfiles.get(settings))) add(parseProfile(name, raw, "settings"), false);

	const projectDir = findAllNearestProjectConfigDirs("profiles", cwd).find(
		entry => entry.source === PROFILE_CONFIG_SOURCE,
	);
	for (const parsed of readProfileDir(projectDir?.path, "project")) add(parsed, true);

	return { profiles: [...byName.values()], warnings };
}

/** Looks a profile up by name, ignoring case. */
export function findProfile(catalog: ProfileCatalog, name: string): ProfileDefinition | undefined {
	const key = name.trim().toLowerCase();
	return catalog.profiles.find(profile => profile.name.toLowerCase() === key);
}
