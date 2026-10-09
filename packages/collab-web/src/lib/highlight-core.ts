import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { solidity, yul } from "highlightjs-solidity";

/**
 * highlight.js with only the grammars the file viewer maps (see `highlight.ts`).
 * Imported lazily, so none of this is in the initial bundle.
 */
const grammars = {
	bash,
	c,
	cpp,
	css,
	diff,
	dockerfile,
	go,
	ini,
	java,
	javascript,
	json,
	kotlin,
	makefile,
	markdown,
	php,
	python,
	ruby,
	rust,
	solidity,
	sql,
	swift,
	typescript,
	xml,
	yaml,
	yul,
};
for (const [name, grammar] of Object.entries(grammars)) hljs.registerLanguage(name, grammar);

export { hljs };
