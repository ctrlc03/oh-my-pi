/** Markdown files the companion embeds as text (`import text from "./x.md" with { type: "text" }`); bun inlines them, including in a compiled build. */
declare module "*.md" {
	const text: string;
	export default text;
}
