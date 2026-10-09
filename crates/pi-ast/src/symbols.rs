//! Symbol definitions and references extracted with one tree-sitter walk.

use std::{collections::HashSet, path::Path};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::{
	language::SupportLang,
	parse_cache::parse_cached,
	summary::{node_content_end_line, node_start_line, resolve_language},
};

const MAX_SIGNATURE_CHARS: usize = 240;
const MAX_DOC_CHARS: usize = 600;
/// Deepest AST level walked; guards the native stack against pathological
/// inputs such as thousand-term binary expressions or call chains.
const MAX_DEPTH: u32 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolOptions {
	/// Source code to index.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CodeSymbol {
	/// Bare identifier: "handle", "`CiphernodeSelector`", "`E3Requested`".
	pub name:       String,
	/// function, method, struct, enum, union, trait, impl, class, interface,
	/// type, const, static, variable, module, macro, contract, library, event,
	/// modifier or error.
	pub kind:       String,
	/// 1-indexed inclusive start line.
	pub start_line: u32,
	/// 1-indexed inclusive end line (last line with content).
	pub end_line:   u32,
	/// Declaration header up to (not including) the body, whitespace
	/// collapsed, max 240 chars.
	pub signature:  String,
	/// Contiguous doc comment directly above, markers stripped, max 600
	/// chars.
	pub doc:        Option<String>,
	/// Index into `symbols` of the innermost enclosing symbol.
	pub parent:     Option<u32>,
	/// Rust `impl T for X`: `T` source text; TS/JS class `implements` /
	/// `extends` list; Solidity `contract A is B, C` bases, joined by ", ".
	pub impl_trait: Option<String>,
	/// Rust impl self type text.
	pub impl_for:   Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolRef {
	/// Last identifier of the referenced path.
	pub name:   String,
	/// 1-indexed line.
	pub line:   u32,
	/// "call" | "type" | "construct" | "import" | "emit" | "macro" | "path" |
	/// "string" (a string literal that looks like a name, e.g. a circuit or
	/// event identifier).
	pub kind:   String,
	/// Index into `symbols` of the innermost enclosing symbol.
	pub scope:  Option<u32>,
	/// Last identifier of the innermost call whose argument list contains this
	/// reference.
	pub callee: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolResult {
	/// Canonical language name when parsing succeeded.
	pub language: Option<String>,
	/// True when the language is supported and tree-sitter produced a tree.
	pub parsed:   bool,
	/// Definitions in source order.
	pub symbols:  Vec<CodeSymbol>,
	/// References in source order.
	pub refs:     Vec<SymbolRef>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Family {
	Rust,
	Ts,
	Solidity,
	Python,
	Go,
}

impl Family {
	const fn of(language: SupportLang) -> Option<Self> {
		match language {
			SupportLang::Rust => Some(Self::Rust),
			SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => Some(Self::Ts),
			SupportLang::Solidity => Some(Self::Solidity),
			SupportLang::Python => Some(Self::Python),
			SupportLang::Go => Some(Self::Go),
			_ => None,
		}
	}
}

/// Walk context: innermost enclosing symbol and innermost enclosing call.
#[derive(Clone, Copy)]
struct Ctx<'a> {
	scope:  Option<u32>,
	callee: Option<&'a str>,
}

type RefKey<'a> = (&'a str, u32, &'static str, Option<u32>, Option<&'a str>);

struct Walker<'a> {
	src:     &'a str,
	family:  Family,
	/// Noir source walked with the Rust grammar.
	noir:    bool,
	symbols: Vec<CodeSymbol>,
	refs:    Vec<SymbolRef>,
	seen:    HashSet<RefKey<'a>>,
	depth:   u32,
}

/// Noir has no grammar here; its syntax is close enough to Rust that the Rust
/// grammar recovers every item and call, so `.nr` sources are walked as Rust.
fn is_noir(options: &SymbolOptions) -> bool {
	match options.lang.as_deref().map(str::trim) {
		Some(lang) if !lang.is_empty() => {
			lang.eq_ignore_ascii_case("noir") || lang.eq_ignore_ascii_case("nr")
		},
		_ => options.path.as_deref().is_some_and(|path| {
			Path::new(path.trim())
				.extension()
				.is_some_and(|ext| ext == "nr")
		}),
	}
}

/// String contents worth indexing: identifier-like names (`share_decryption`,
/// `ICiphernodeRegistry`, `a/b-c.d`), not prose or format strings.
fn is_name_like(text: &str) -> bool {
	let mut bytes = text.bytes();
	(3..=64).contains(&text.len())
		&& bytes
			.next()
			.is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
		&& bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-'))
}

pub fn extract_symbols(options: SymbolOptions) -> Result<SymbolResult> {
	let unparsed =
		SymbolResult { language: None, parsed: false, symbols: Vec::new(), refs: Vec::new() };
	let noir = is_noir(&options);
	let language = if noir {
		Some(SupportLang::Rust)
	} else {
		resolve_language(options.lang.as_deref(), options.path.as_deref())
	};
	let Some(language) = language else {
		return Ok(unparsed);
	};
	let Some(family) = Family::of(language) else {
		return Ok(unparsed);
	};
	let Some(tree) = parse_cached(&options.code, language)? else {
		return Ok(unparsed);
	};

	let mut walker = Walker {
		src: &options.code,
		family,
		noir,
		symbols: Vec::new(),
		refs: Vec::new(),
		seen: HashSet::new(),
		depth: 0,
	};
	walker.walk(tree.root_node(), Ctx { scope: None, callee: None });
	Ok(SymbolResult {
		language: Some(
			if noir {
				"noir"
			} else {
				language.canonical_name()
			}
			.to_string(),
		),
		parsed:   true,
		symbols:  walker.symbols,
		refs:     walker.refs,
	})
}

fn kids(node: Node<'_>) -> Vec<Node<'_>> {
	node.children(&mut node.walk()).collect()
}

fn upper_first(text: &str) -> bool {
	text.chars().next().is_some_and(char::is_uppercase)
}

fn truncate_chars(mut text: String, max: usize) -> String {
	if let Some((index, _)) = text.char_indices().nth(max) {
		text.truncate(index);
	}
	let len = text.trim_end().len();
	text.truncate(len);
	text
}

/// Collapse whitespace runs to single spaces and cap at `max` chars.
fn collapse(text: &str, max: usize) -> String {
	let mut out = String::with_capacity(text.len().min(max * 2));
	for word in text.split_whitespace() {
		if !out.is_empty() {
			out.push(' ');
		}
		out.push_str(word);
		if out.len() > max * 4 {
			break;
		}
	}
	truncate_chars(out, max)
}

/// Node that owns the doc comment, line span and signature start: the
/// wrapping `export`, decorator list or single-spec `type` declaration.
fn outer_of(node: Node<'_>) -> Node<'_> {
	match node.parent() {
		Some(parent) => match parent.kind() {
			"export_statement" | "decorated_definition" => parent,
			"type_declaration" if parent.named_child_count() == 1 => parent,
			_ => node,
		},
		None => node,
	}
}

fn unwrap_expression(mut node: Node<'_>) -> Node<'_> {
	while node.kind() == "expression" && node.named_child_count() == 1 {
		match node.named_child(0) {
			Some(child) => node = child,
			None => break,
		}
	}
	node
}

impl<'a> Walker<'a> {
	fn text(&self, node: Node<'_>) -> &'a str {
		self.src.get(node.byte_range()).unwrap_or_default()
	}

	fn scope_kind(&self, ctx: Ctx<'a>) -> Option<&str> {
		ctx.scope
			.map(|scope| self.symbols[scope as usize].kind.as_str())
	}

	fn add_ref(&mut self, name: &'a str, at: Node<'_>, kind: &'static str, ctx: Ctx<'a>) {
		if name.is_empty() {
			return;
		}
		let line = node_start_line(at);
		if self.seen.insert((name, line, kind, ctx.scope, ctx.callee)) {
			self.refs.push(SymbolRef {
				name: name.to_string(),
				line,
				kind: kind.to_string(),
				scope: ctx.scope,
				callee: ctx.callee.map(str::to_string),
			});
		}
	}

	fn add_node_ref(&mut self, node: Node<'_>, kind: &'static str, ctx: Ctx<'a>) {
		let name = self.text(node);
		self.add_ref(name, node, kind, ctx);
	}

	/// Record a string literal whose whole content looks like a name; the
	/// literal's quotes are stripped, nested interpolations are still walked.
	fn walk_string(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let inner = self
			.text(node)
			.strip_prefix(['"', '\''])
			.and_then(|text| text.strip_suffix(['"', '\'']));
		if let Some(inner) = inner.filter(|text| is_name_like(text)) {
			self.add_ref(inner, node, "string", ctx);
		}
		self.walk_children(node, ctx, None);
	}

	fn walk_children(&mut self, node: Node<'_>, ctx: Ctx<'a>, skip: Option<usize>) {
		let mut cursor = node.walk();
		if !cursor.goto_first_child() {
			return;
		}
		loop {
			let child = cursor.node();
			if child.is_named() && skip != Some(child.id()) {
				self.walk(child, ctx);
			}
			if !cursor.goto_next_sibling() {
				break;
			}
		}
	}

	/// Every recursive path (children, call heads, member receivers) goes
	/// through here, so `MAX_DEPTH` bounds the native stack for all of them.
	fn walk(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		if self.depth >= MAX_DEPTH {
			return;
		}
		self.depth += 1;
		match self.family {
			Family::Rust => self.walk_rust(node, ctx),
			Family::Ts => self.walk_ts(node, ctx),
			Family::Solidity => self.walk_solidity(node, ctx),
			Family::Python => self.walk_python(node, ctx),
			Family::Go => self.walk_go(node, ctx),
		}
		self.depth -= 1;
	}

	// ── definitions ─────────────────────────────────────────────────────

	/// Define `node` named by `name_node`, then walk its children inside the
	/// new symbol's scope.
	fn define(
		&mut self,
		node: Node<'_>,
		name_node: Option<Node<'_>>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<u32> {
		let name = name_node.map(|n| self.text(n));
		let sig_end = node.child_by_field_name("body").map(|b| b.start_byte());
		self.define_as(node, outer_of(node), name, name_node.map(|n| n.id()), sig_end, kind, ctx)
	}

	#[allow(
		clippy::too_many_arguments,
		reason = "one call site per definition shape; a params struct would only rename them"
	)]
	fn define_as(
		&mut self,
		node: Node<'_>,
		outer: Node<'_>,
		name: Option<&'a str>,
		skip: Option<usize>,
		sig_end: Option<usize>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<u32> {
		let name = name
			.map(|n| n.trim_matches(['"', '\'', '`']))
			.filter(|n| !n.is_empty());
		let Some(name) = name else {
			self.walk_children(node, ctx, None);
			return None;
		};
		let sig_start = if outer.kind() == "decorated_definition" {
			node.start_byte()
		} else {
			outer.start_byte()
		};
		let sig_end = sig_end
			.filter(|end| *end >= sig_start)
			.unwrap_or_else(|| outer.end_byte());
		let signature = self
			.src
			.get(sig_start..sig_end)
			.map_or_default(|text| collapse(text, MAX_SIGNATURE_CHARS));
		let index = self.symbols.len() as u32;
		let doc = self.leading_doc(outer);
		self.symbols.push(CodeSymbol {
			name: name.to_string(),
			kind: kind.to_string(),
			start_line: node_start_line(outer),
			end_line: node_content_end_line(outer),
			signature,
			doc,
			parent: ctx.scope,
			impl_trait: None,
			impl_for: None,
		});
		self.walk_children(node, Ctx { scope: Some(index), callee: None }, skip);
		Some(index)
	}

	// ── doc comments ────────────────────────────────────────────────────

	fn is_comment(&self, kind: &str) -> bool {
		match self.family {
			Family::Rust => matches!(kind, "line_comment" | "block_comment"),
			_ => kind == "comment",
		}
	}

	/// Body text of a doc comment, or `None` when `text` is a plain comment
	/// for this language.
	fn doc_body(&self, text: &str) -> Option<String> {
		if text.starts_with("/*") {
			let inner = match self.family {
				Family::Go => text.strip_prefix("/*"),
				Family::Rust => text
					.strip_prefix("/**")
					.or_else(|| text.strip_prefix("/*!")),
				_ => text.strip_prefix("/**"),
			}?;
			if inner.starts_with('/') {
				return None;
			}
			let inner = inner.strip_suffix("*/").unwrap_or(inner);
			let lines = inner
				.lines()
				.map(|line| line.trim().trim_start_matches('*').trim())
				.filter(|line| !line.is_empty())
				.collect::<Vec<_>>();
			return Some(lines.join(" "));
		}
		let inner = match self.family {
			Family::Rust => text
				.strip_prefix("///")
				.filter(|rest| !rest.starts_with('/'))
				.or_else(|| text.strip_prefix("//!")),
			Family::Solidity => text
				.strip_prefix("///")
				.filter(|rest| !rest.starts_with('/')),
			Family::Go => text.strip_prefix("//"),
			_ => None,
		}?;
		Some(inner.trim().to_string())
	}

	/// Contiguous doc comments directly above `outer`, skipping Rust outer
	/// attributes between them and the item.
	fn leading_doc(&self, outer: Node<'_>) -> Option<String> {
		if self.family == Family::Python {
			return None;
		}
		let mut parts = Vec::new();
		let mut next_row = outer.start_position().row;
		let mut sibling = outer.prev_sibling();
		while let Some(node) = sibling {
			let kind = node.kind();
			let end_row = node_content_end_line(node) as usize - 1;
			if end_row + 1 < next_row {
				break;
			}
			if self.is_comment(kind) {
				match self.doc_body(self.text(node)) {
					Some(body) => parts.push(body),
					None => break,
				}
			} else if !(self.family == Family::Rust && kind == "attribute_item") {
				break;
			}
			next_row = node.start_position().row;
			sibling = node.prev_sibling();
		}
		parts.reverse();
		let doc = collapse(&parts.join(" "), MAX_DOC_CHARS);
		(!doc.is_empty()).then_some(doc)
	}

	// ── Rust ────────────────────────────────────────────────────────────

	fn walk_rust(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let name = node.child_by_field_name("name");
		match node.kind() {
			"function_item" | "function_signature_item" => {
				let kind = if matches!(self.scope_kind(ctx), Some("impl" | "trait")) {
					"method"
				} else {
					"function"
				};
				self.define(node, name, kind, ctx);
			},
			"struct_item" => {
				self.define(node, name, "struct", ctx);
			},
			"enum_item" => {
				self.define(node, name, "enum", ctx);
			},
			"union_item" => {
				self.define(node, name, "union", ctx);
			},
			"trait_item" => {
				self.define(node, name, "trait", ctx);
			},
			"type_item" => {
				self.define(node, name, "type", ctx);
			},
			"const_item" => {
				self.define(node, name, "const", ctx);
			},
			"static_item" => {
				self.define(node, name, "static", ctx);
			},
			"mod_item" => {
				self.define(node, name, "module", ctx);
			},
			"macro_definition" => {
				self.define(node, name, "macro", ctx);
			},
			"impl_item" => self.rust_impl(node, ctx),
			"use_declaration" => {
				if let Some(argument) = node.child_by_field_name("argument") {
					self.rust_use(argument, None, ctx);
				}
			},
			"attribute_item" | "inner_attribute_item" => {},
			"string_literal" => self.walk_string(node, ctx),
			"identifier" if self.noir && self.text(node) == "global" => self.noir_global(node, ctx),
			"macro_invocation" => {
				if let Some(target) = node.child_by_field_name("macro") {
					let leaf = target.child_by_field_name("name").unwrap_or(target);
					self.add_node_ref(leaf, "macro", ctx);
				}
			},
			"call_expression" => {
				let function = node.child_by_field_name("function");
				let head = function.and_then(|f| self.rust_call_head(f, ctx));
				// Transparent wrappers (`TypedEvent::new(X { .. })`, `Box::new`,
				// `Some`) pass the enclosing call through, so the
				// wrapped value is credited to the real callee.
				let callee = match head {
					Some(
						"new" | "from" | "into" | "clone" | "to_owned" | "Some" | "Ok" | "Err" | "Box"
						| "Arc" | "Rc" | "wrap",
					) => ctx.callee,
					other => other,
				};
				if let Some(arguments) = node.child_by_field_name("arguments") {
					self.walk_children(arguments, Ctx { scope: ctx.scope, callee }, None);
				}
			},
			"struct_expression" => {
				if let Some(target) = name {
					self.rust_head_ref(target, "construct", ctx);
				}
				if let Some(body) = node.child_by_field_name("body") {
					self.walk_children(body, ctx, None);
				}
			},
			"tuple_struct_pattern" => {
				let target = node.child_by_field_name("type");
				if let Some(target) = target {
					if target.kind() == "identifier"
						&& !matches!(self.text(target), "Some" | "Ok" | "Err")
					{
						self.add_node_ref(target, "path", ctx);
					} else if target.kind() != "identifier" {
						self.walk(target, ctx);
					}
				}
				self.walk_children(node, ctx, target.map(|t| t.id()));
			},
			"struct_pattern" => {
				// `Ev::Struct { .. }` arms name a variant, like tuple-struct arms.
				let target = node.child_by_field_name("type");
				if let Some(target) = target {
					if target.kind() == "scoped_type_identifier" {
						self.rust_head_ref(target, "path", ctx);
					} else {
						self.walk(target, ctx);
					}
				}
				self.walk_children(node, ctx, target.map(|t| t.id()));
			},
			"scoped_identifier" => self.rust_head_ref(node, "path", ctx),
			"scoped_type_identifier" => self.rust_head_ref(node, "type", ctx),
			"type_identifier" => {
				if self.text(node) != "Self" {
					self.add_node_ref(node, "type", ctx);
				}
			},
			"type_parameter" | "constrained_type_parameter" | "associated_type" => {
				let declared = name.or_else(|| node.child_by_field_name("left"));
				self.walk_children(node, ctx, declared.map(|d| d.id()));
			},
			_ => self.walk_children(node, ctx, None),
		}
	}

	/// Noir `global NAME: T = value;` has no Rust counterpart; the Rust
	/// grammar recovers it as `global` followed by an error node (or, with
	/// `pub`, an error node holding `global NAME`). Define the const named by
	/// the identifier after `global`.
	fn noir_global(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let name = node.next_sibling().and_then(|next| match next.kind() {
			"identifier" => Some(next),
			"ERROR" => next.child(0).filter(|c| c.kind() == "identifier"),
			_ => None,
		});
		let Some(name) = name else { return };
		let mut outer = node;
		while let Some(parent) = outer.parent().filter(|p| {
			matches!(
				p.kind(),
				"index_expression" | "assignment_expression" | "expression_statement" | "ERROR"
			)
		}) {
			outer = parent;
		}
		let text = Some(self.text(name));
		self.define_as(node, outer, text, None, None, "const", ctx);
	}

	fn rust_impl(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let self_type = node.child_by_field_name("type");
		let trait_type = node.child_by_field_name("trait");
		let name = self_type.map_or("", |t| self.rust_type_name(t));
		let sig_end = node.child_by_field_name("body").map(|b| b.start_byte());
		let Some(index) = self.define_as(node, node, Some(name), None, sig_end, "impl", ctx) else {
			return;
		};
		let symbol = &mut self.symbols[index as usize];
		symbol.impl_for = self_type.map(|t| collapse(&self.src[t.byte_range()], MAX_SIGNATURE_CHARS));
		symbol.impl_trait =
			trait_type.map(|t| collapse(&self.src[t.byte_range()], MAX_SIGNATURE_CHARS));
	}

	/// Last identifier of a Rust type: `Foo<T>` → `Foo`, `a::b::Foo` → `Foo`.
	fn rust_type_name(&self, mut node: Node<'_>) -> &'a str {
		loop {
			let next = match node.kind() {
				"type_identifier" | "identifier" => return self.text(node),
				"scoped_type_identifier" | "scoped_identifier" => node.child_by_field_name("name"),
				"generic_type" | "reference_type" | "pointer_type" => node.child_by_field_name("type"),
				"dynamic_type" | "abstract_type" => node
					.child_by_field_name("trait")
					.or_else(|| node.child_by_field_name("type")),
				_ => None,
			};
			match next {
				Some(next) => node = next,
				None => return self.text(node),
			}
		}
	}

	/// Leaf names of a `use` tree; `parent` is the enclosing path's last
	/// segment, used for `{self}`.
	fn rust_use(&mut self, node: Node<'_>, parent: Option<Node<'_>>, ctx: Ctx<'a>) {
		match node.kind() {
			"identifier" => self.add_node_ref(node, "import", ctx),
			"scoped_identifier" => {
				if let Some(leaf) = node.child_by_field_name("name") {
					self.add_node_ref(leaf, "import", ctx);
				}
			},
			"use_as_clause" => {
				if let Some(path) = node.child_by_field_name("path") {
					self.rust_use(path, parent, ctx);
				}
			},
			"scoped_use_list" => {
				let path = node.child_by_field_name("path");
				let last = path.map(|p| p.child_by_field_name("name").unwrap_or(p));
				if let Some(list) = node.child_by_field_name("list") {
					self.rust_use(list, last, ctx);
				}
			},
			"use_list" => {
				for child in kids(node) {
					if child.is_named() {
						self.rust_use(child, parent, ctx);
					}
				}
			},
			"self" => {
				if let Some(parent) = parent {
					self.add_node_ref(parent, "import", ctx);
				}
			},
			_ => {},
		}
	}

	fn rust_call_head(&mut self, function: Node<'_>, ctx: Ctx<'a>) -> Option<&'a str> {
		match function.kind() {
			"identifier" => {
				// Upper-case heads are tuple struct / variant constructors, not
				// calls.
				let text = self.text(function);
				let kind = if upper_first(text) && !matches!(text, "Some" | "Ok" | "Err") {
					"construct"
				} else {
					"call"
				};
				self.add_node_ref(function, kind, ctx);
				Some(text)
			},
			"field_expression" => {
				if let Some(value) = function.child_by_field_name("value") {
					self.walk(value, ctx);
				}
				let field = function.child_by_field_name("field")?;
				self.add_node_ref(field, "call", ctx);
				Some(self.text(field))
			},
			"scoped_identifier" => {
				let leaf = function.child_by_field_name("name");
				let kind = if leaf.is_some_and(|n| upper_first(self.text(n))) {
					"construct"
				} else {
					"call"
				};
				self.rust_head_ref(function, kind, ctx);
				leaf.map(|n| self.text(n))
			},
			"generic_function" => {
				let head = function
					.child_by_field_name("function")
					.and_then(|f| self.rust_call_head(f, ctx));
				if let Some(arguments) = function.child_by_field_name("type_arguments") {
					self.walk_children(arguments, ctx, None);
				}
				head
			},
			_ => {
				self.walk(function, ctx);
				None
			},
		}
	}

	/// Emit `kind` for the last segment of a (possibly scoped or generic)
	/// Rust path plus a `type` ref for its qualifier.
	fn rust_head_ref(&mut self, node: Node<'_>, kind: &'static str, ctx: Ctx<'a>) {
		match node.kind() {
			"identifier" | "type_identifier" => self.add_node_ref(node, kind, ctx),
			"scoped_identifier" | "scoped_type_identifier" => {
				if let Some(leaf) = node.child_by_field_name("name") {
					self.add_node_ref(leaf, kind, ctx);
				}
				if let Some(path) = node.child_by_field_name("path") {
					self.rust_qualifier(path, ctx);
				}
			},
			"generic_type" | "generic_type_with_turbofish" => {
				if let Some(inner) = node.child_by_field_name("type") {
					self.rust_head_ref(inner, kind, ctx);
				}
				if let Some(arguments) = node.child_by_field_name("type_arguments") {
					self.walk_children(arguments, ctx, None);
				}
			},
			_ => self.walk(node, ctx),
		}
	}

	/// `type` refs for every upper-case segment of a path qualifier: for
	/// `a::Foo::Bar::call`, the qualifier `a::Foo::Bar` yields `Foo` and
	/// `Bar`.
	fn rust_qualifier(&mut self, mut path: Node<'_>, ctx: Ctx<'a>) {
		loop {
			let (leaf, rest) = match path.kind() {
				"identifier" | "type_identifier" => (path, None),
				"scoped_identifier" | "scoped_type_identifier" => {
					match path.child_by_field_name("name") {
						Some(name) => (name, path.child_by_field_name("path")),
						None => return,
					}
				},
				"crate" | "self" | "super" | "metavariable" => return,
				_ => return self.walk(path, ctx),
			};
			if upper_first(self.text(leaf)) {
				self.add_node_ref(leaf, "type", ctx);
			}
			match rest {
				Some(rest) => path = rest,
				None => return,
			}
		}
	}

	// ── TypeScript / JavaScript ─────────────────────────────────────────

	fn walk_ts(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let name = node.child_by_field_name("name");
		match node.kind() {
			"function_declaration" | "generator_function_declaration" | "function_signature" => {
				self.define(node, name, "function", ctx);
			},
			"class_declaration" | "abstract_class_declaration" => {
				if let Some(index) = self.define(node, name, "class", ctx) {
					self.symbols[index as usize].impl_trait = self.ts_heritage_text(node);
				}
			},
			"method_definition" | "method_signature" | "abstract_method_signature" => {
				let member = name.filter(|n| n.kind() != "computed_property_name");
				self.define(node, member, "method", ctx);
			},
			"public_field_definition" | "field_definition" => {
				let member = name.or_else(|| node.child_by_field_name("property"));
				let function = node.child_by_field_name("value").filter(|v| {
					matches!(v.kind(), "arrow_function" | "function_expression" | "generator_function")
				});
				match (member.filter(|n| n.kind() != "computed_property_name"), function) {
					(Some(member), Some(function)) => {
						let sig_end = function.child_by_field_name("body").map(|b| b.start_byte());
						let member_name = Some(self.text(member));
						self.define_as(
							node,
							node,
							member_name,
							Some(member.id()),
							sig_end,
							"method",
							ctx,
						);
					},
					_ => self.walk_children(node, ctx, None),
				}
			},
			"interface_declaration" => {
				if let Some(index) = self.define(node, name, "interface", ctx) {
					let bases = kids(node)
						.into_iter()
						.find(|c| c.kind() == "extends_type_clause")
						.map(|clause| {
							kids(clause)
								.into_iter()
								.filter(|c| c.is_named())
								.map(|c| collapse(self.text(c), MAX_SIGNATURE_CHARS))
								.collect::<Vec<_>>()
								.join(", ")
						})
						.filter(|bases| !bases.is_empty());
					self.symbols[index as usize].impl_trait = bases;
				}
			},
			"type_alias_declaration" => {
				self.define(node, name, "type", ctx);
			},
			"enum_declaration" => {
				self.define(node, name, "enum", ctx);
			},
			"module" | "internal_module" => {
				self.define(node, name, "module", ctx);
			},
			"lexical_declaration" | "variable_declaration" => self.ts_variable(node, ctx),
			"call_expression" => {
				let function = node.child_by_field_name("function");
				let callee = function.and_then(|f| self.ts_call_head(f, "call", ctx));
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, function.map(|f| f.id()));
			},
			"new_expression" => {
				let target = node.child_by_field_name("constructor");
				let callee = target.and_then(|t| self.ts_call_head(t, "construct", ctx));
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, target.map(|t| t.id()));
			},
			"member_expression" => {
				let object = node.child_by_field_name("object");
				if object.is_some_and(|o| o.kind() == "identifier" && upper_first(self.text(o))) {
					self.ts_member_ref(node, "path", ctx);
				} else if let Some(object) = object {
					self.walk(object, ctx);
				}
			},
			"import_statement" => self.ts_import(node, ctx),
			"export_statement" => {
				if node.child_by_field_name("source").is_some() {
					for clause in kids(node)
						.into_iter()
						.filter(|c| c.kind() == "export_clause")
					{
						for specifier in kids(clause) {
							if let Some(leaf) = specifier.child_by_field_name("name") {
								self.add_node_ref(leaf, "import", ctx);
							}
						}
					}
				} else {
					self.walk_children(node, ctx, None);
				}
			},
			"string" => self.walk_string(node, ctx),
			"type_identifier" => self.add_node_ref(node, "type", ctx),
			"nested_type_identifier" => {
				if let Some(leaf) = name {
					self.add_node_ref(leaf, "type", ctx);
				}
				if let Some(module) = node.child_by_field_name("module")
					&& module.kind() == "identifier"
					&& upper_first(self.text(module))
				{
					self.add_node_ref(module, "type", ctx);
				}
			},
			"type_parameter" => self.walk_children(node, ctx, name.map(|n| n.id())),
			"class_heritage" => {
				for child in kids(node).into_iter().filter(|c| c.is_named()) {
					if matches!(child.kind(), "extends_clause" | "implements_clause") {
						self.walk(child, ctx);
					} else {
						self.ts_heritage_value(child, ctx);
					}
				}
			},
			"extends_clause" => {
				let value = node.child_by_field_name("value");
				if let Some(value) = value {
					self.ts_heritage_value(value, ctx);
				}
				self.walk_children(node, ctx, value.map(|v| v.id()));
			},
			"decorator" => {
				for child in kids(node).into_iter().filter(|c| c.is_named()) {
					match child.kind() {
						"identifier" => self.add_node_ref(child, "call", ctx),
						"member_expression" => {
							self.ts_member_ref(child, "call", ctx);
						},
						_ => self.walk(child, ctx),
					}
				}
			},
			"jsx_opening_element" | "jsx_self_closing_element" => {
				if let Some(tag) = name {
					match tag.kind() {
						"identifier" if upper_first(self.text(tag)) => {
							self.add_node_ref(tag, "construct", ctx);
						},
						"member_expression" => {
							self.ts_member_ref(tag, "construct", ctx);
						},
						_ => {},
					}
				}
				self.walk_children(node, Ctx { scope: ctx.scope, callee: None }, name.map(|n| n.id()));
			},
			_ => self.walk_children(node, ctx, None),
		}
	}

	fn ts_heritage_text(&self, node: Node<'_>) -> Option<String> {
		let heritage = kids(node)
			.into_iter()
			.find(|c| c.kind() == "class_heritage")?;
		let mut parts = Vec::new();
		for clause in kids(heritage).into_iter().filter(|c| c.is_named()) {
			match clause.kind() {
				"extends_clause" => {
					if let Some(value) = clause.child_by_field_name("value") {
						let text = &self.src[value.start_byte()..clause.end_byte()];
						parts.push(collapse(text, MAX_SIGNATURE_CHARS));
					}
				},
				"implements_clause" => {
					for ty in kids(clause).into_iter().filter(|c| c.is_named()) {
						parts.push(collapse(self.text(ty), MAX_SIGNATURE_CHARS));
					}
				},
				_ => parts.push(collapse(self.text(clause), MAX_SIGNATURE_CHARS)),
			}
		}
		(!parts.is_empty()).then(|| parts.join(", "))
	}

	/// `class A extends <value>`: the base is a type usage.
	fn ts_heritage_value(&mut self, value: Node<'_>, ctx: Ctx<'a>) {
		match value.kind() {
			"identifier" => self.add_node_ref(value, "type", ctx),
			"member_expression" => {
				self.ts_member_ref(value, "type", ctx);
			},
			_ => self.walk(value, ctx),
		}
	}

	/// Emit `kind` for `a.b`'s property; an upper-case identifier receiver is
	/// also a `type` ref, anything else is walked for nested refs.
	fn ts_member_ref(
		&mut self,
		node: Node<'_>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<&'a str> {
		if let Some(object) = node.child_by_field_name("object") {
			if object.kind() == "identifier" && upper_first(self.text(object)) {
				self.add_node_ref(object, "type", ctx);
			} else {
				self.walk(object, ctx);
			}
		}
		let property = node.child_by_field_name("property")?;
		self.add_node_ref(property, kind, ctx);
		Some(self.text(property))
	}

	fn ts_call_head(
		&mut self,
		function: Node<'_>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<&'a str> {
		match function.kind() {
			"identifier" => {
				self.add_node_ref(function, kind, ctx);
				Some(self.text(function))
			},
			"member_expression" => self.ts_member_ref(function, kind, ctx),
			"non_null_expression" | "parenthesized_expression" => {
				let inner = function.named_child(0)?;
				self.ts_call_head(inner, kind, ctx)
			},
			"super" | "import" | "this" => None,
			_ => {
				self.walk(function, ctx);
				None
			},
		}
	}

	fn ts_import(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		for clause in kids(node)
			.into_iter()
			.filter(|c| c.kind() == "import_clause")
		{
			for part in kids(clause) {
				match part.kind() {
					"identifier" => self.add_node_ref(part, "import", ctx),
					"named_imports" => {
						for specifier in kids(part) {
							if let Some(leaf) = specifier.child_by_field_name("name") {
								let text = self.text(leaf).trim_matches(['"', '\'']);
								self.add_ref(text, leaf, "import", ctx);
							}
						}
					},
					_ => {},
				}
			}
		}
	}

	fn ts_variable(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let statement = outer_of(node);
		let exported_top = statement.kind() == "export_statement"
			&& statement.parent().is_some_and(|p| p.kind() == "program");
		let is_const = node.kind() == "lexical_declaration"
			&& node
				.child_by_field_name("kind")
				.is_some_and(|k| self.text(k) == "const");
		let declarators = kids(node)
			.into_iter()
			.filter(|c| c.kind() == "variable_declarator")
			.collect::<Vec<_>>();
		let single = declarators.len() == 1;
		for declarator in declarators {
			let name = declarator
				.child_by_field_name("name")
				.filter(|n| n.kind() == "identifier");
			let function = declarator.child_by_field_name("value").filter(|v| {
				matches!(
					v.kind(),
					"arrow_function" | "function_expression" | "function" | "generator_function"
				)
			});
			let kind = match (name, function, exported_top) {
				(None, ..) | (_, None, false) => {
					self.walk(declarator, ctx);
					continue;
				},
				(Some(_), Some(_), _) => "function",
				(Some(_), None, true) if is_const => "const",
				(Some(_), None, true) => "variable",
			};
			let Some(name) = name else { continue };
			let sig_end = function
				.and_then(|f| f.child_by_field_name("body"))
				.map(|b| b.start_byte());
			let outer = if single { statement } else { declarator };
			let name_text = Some(self.text(name));
			self.define_as(declarator, outer, name_text, Some(name.id()), sig_end, kind, ctx);
		}
	}

	// ── Solidity ────────────────────────────────────────────────────────

	fn walk_solidity(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let name = node.child_by_field_name("name");
		match node.kind() {
			"contract_declaration" | "interface_declaration" | "library_declaration" => {
				let kind = match node.kind() {
					"contract_declaration" => "contract",
					"interface_declaration" => "interface",
					_ => "library",
				};
				if let Some(index) = self.define(node, name, kind, ctx) {
					let bases = kids(node)
						.into_iter()
						.filter(|c| c.kind() == "inheritance_specifier")
						.filter_map(|c| c.child_by_field_name("ancestor"))
						.map(|ancestor| collapse(self.text(ancestor), MAX_SIGNATURE_CHARS))
						.collect::<Vec<_>>()
						.join(", ");
					self.symbols[index as usize].impl_trait = (!bases.is_empty()).then_some(bases);
				}
			},
			"function_definition" => {
				self.define(node, name, "function", ctx);
			},
			"modifier_definition" => {
				self.define(node, name, "modifier", ctx);
			},
			"event_definition" => {
				self.define(node, name, "event", ctx);
			},
			"error_declaration" => {
				self.define(node, name, "error", ctx);
			},
			"struct_declaration" => {
				self.define(node, name, "struct", ctx);
			},
			"enum_declaration" => {
				self.define(node, name, "enum", ctx);
			},
			"state_variable_declaration" => {
				self.define(node, name, "variable", ctx);
			},
			"constant_variable_declaration" => {
				self.define(node, name, "const", ctx);
			},
			"user_defined_type_definition" => {
				self.define(node, name, "type", ctx);
			},
			"constructor_definition" | "fallback_receive_definition" => {
				let label = if node.kind() == "constructor_definition" {
					"constructor"
				} else if self.text(node).starts_with("receive") {
					"receive"
				} else {
					"fallback"
				};
				let sig_end = node.child_by_field_name("body").map(|b| b.start_byte());
				self.define_as(node, node, Some(label), None, sig_end, "function", ctx);
			},
			"string" => self.walk_string(node, ctx),
			"import_directive" => {
				let mut cursor = node.walk();
				let names = node
					.children_by_field_name("import_name", &mut cursor)
					.collect::<Vec<_>>();
				for leaf in names {
					self.add_node_ref(leaf, "import", ctx);
				}
			},
			"emit_statement" => {
				let event = name.map(unwrap_expression);
				if let Some(event) = event {
					match event.kind() {
						"identifier" => self.add_node_ref(event, "emit", ctx),
						"member_expression" => {
							self.sol_member_ref(event, "emit", ctx);
						},
						_ => self.walk(event, ctx),
					}
				}
				self.walk_children(node, Ctx { scope: ctx.scope, callee: None }, name.map(|n| n.id()));
			},
			"revert_statement" => {
				let error = node.child_by_field_name("error");
				let head = error.map(unwrap_expression);
				if let Some(head) = head {
					match head.kind() {
						"identifier" => self.add_node_ref(head, "call", ctx),
						"member_expression" => {
							self.sol_member_ref(head, "call", ctx);
						},
						_ => self.walk(head, ctx),
					}
				}
				self.walk_children(node, Ctx { scope: ctx.scope, callee: None }, error.map(|e| e.id()));
			},
			"modifier_invocation" => {
				let head = kids(node).into_iter().find(|c| c.kind() == "identifier");
				if let Some(head) = head {
					self.add_node_ref(head, "call", ctx);
				}
				let callee = head.map(|h| self.text(h));
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, head.map(|h| h.id()));
			},
			"call_expression" => {
				let function = node.child_by_field_name("function");
				let is_struct_literal = kids(node).into_iter().any(|c| {
					c.kind() == "call_argument"
						&& c
							.named_child(0)
							.is_some_and(|a| a.kind() == "call_struct_argument")
				});
				let kind = if is_struct_literal {
					"construct"
				} else {
					"call"
				};
				let callee = function.and_then(|f| self.sol_call_head(unwrap_expression(f), kind, ctx));
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, function.map(|f| f.id()));
			},
			"new_expression" => {
				let target = node.child_by_field_name("name");
				let leaf = target.and_then(|t| {
					kids(t)
						.into_iter()
						.find(|c| c.kind() == "user_defined_type")
						.and_then(|u| kids(u).into_iter().rfind(|c| c.kind() == "identifier"))
				});
				if let Some(leaf) = leaf {
					self.add_node_ref(leaf, "construct", ctx);
				}
				let callee = leaf.map(|l| self.text(l));
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, target.map(|t| t.id()));
			},
			"struct_expression" => {
				let target = node.child_by_field_name("type").map(unwrap_expression);
				if let Some(target) = target {
					self.sol_call_head(target, "construct", ctx);
				}
				self.walk_children(node, ctx, node.child_by_field_name("type").map(|t| t.id()));
			},
			"user_defined_type" => {
				let parts = kids(node)
					.into_iter()
					.filter(|c| c.kind() == "identifier")
					.collect::<Vec<_>>();
				for (index, part) in parts.iter().enumerate() {
					if index + 1 == parts.len() || upper_first(self.text(*part)) {
						self.add_node_ref(*part, "type", ctx);
					}
				}
			},
			"member_expression" => {
				let object = node.child_by_field_name("object").map(unwrap_expression);
				if object.is_some_and(|o| o.kind() == "identifier" && upper_first(self.text(o))) {
					self.sol_member_ref(node, "path", ctx);
				} else if let Some(object) = object {
					self.walk(object, ctx);
				}
			},
			_ => self.walk_children(node, ctx, None),
		}
	}

	fn sol_member_ref(
		&mut self,
		node: Node<'_>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<&'a str> {
		if let Some(object) = node.child_by_field_name("object").map(unwrap_expression) {
			if object.kind() == "identifier" && upper_first(self.text(object)) {
				self.add_node_ref(object, "type", ctx);
			} else {
				self.walk(object, ctx);
			}
		}
		let property = node.child_by_field_name("property")?;
		self.add_node_ref(property, kind, ctx);
		Some(self.text(property))
	}

	fn sol_call_head(
		&mut self,
		function: Node<'_>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<&'a str> {
		match function.kind() {
			"identifier" => {
				self.add_node_ref(function, kind, ctx);
				Some(self.text(function))
			},
			"member_expression" => self.sol_member_ref(function, kind, ctx),
			_ => {
				self.walk(function, ctx);
				None
			},
		}
	}

	// ── Python ──────────────────────────────────────────────────────────

	fn walk_python(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let name = node.child_by_field_name("name");
		match node.kind() {
			"function_definition" => {
				let kind = if self.scope_kind(ctx) == Some("class") {
					"method"
				} else {
					"function"
				};
				if let Some(index) = self.define(node, name, kind, ctx) {
					self.symbols[index as usize].doc = self.py_docstring(node);
				}
			},
			"class_definition" => {
				if let Some(index) = self.define(node, name, "class", ctx) {
					self.symbols[index as usize].doc = self.py_docstring(node);
					let bases = node
						.child_by_field_name("superclasses")
						.map(|list| {
							kids(list)
								.into_iter()
								.filter(|c| c.is_named() && c.kind() != "keyword_argument")
								.map(|c| collapse(self.text(c), MAX_SIGNATURE_CHARS))
								.collect::<Vec<_>>()
								.join(", ")
						})
						.filter(|bases| !bases.is_empty());
					self.symbols[index as usize].impl_trait = bases;
				}
			},
			"argument_list"
				if node
					.parent()
					.is_some_and(|p| p.kind() == "class_definition") =>
			{
				for base in kids(node).into_iter().filter(|c| c.is_named()) {
					match base.kind() {
						"identifier" => self.add_node_ref(base, "type", ctx),
						"attribute" => {
							if let Some(leaf) = base.child_by_field_name("attribute") {
								self.add_node_ref(leaf, "type", ctx);
							}
						},
						_ => self.walk(base, ctx),
					}
				}
			},
			"call" => {
				let function = node.child_by_field_name("function");
				let callee = match function {
					Some(f) if f.kind() == "identifier" => {
						self.add_node_ref(f, "call", ctx);
						Some(self.text(f))
					},
					Some(f) if f.kind() == "attribute" => self.py_attribute_ref(f, "call", ctx),
					Some(f) => {
						self.walk(f, ctx);
						None
					},
					None => None,
				};
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, function.map(|f| f.id()));
			},
			"attribute" => {
				let object = node.child_by_field_name("object");
				if object.is_some_and(|o| o.kind() == "identifier" && upper_first(self.text(o))) {
					self.py_attribute_ref(node, "path", ctx);
				} else if let Some(object) = object {
					self.walk(object, ctx);
				}
			},
			"decorator" => {
				for child in kids(node).into_iter().filter(|c| c.is_named()) {
					match child.kind() {
						"identifier" => self.add_node_ref(child, "call", ctx),
						"attribute" => {
							self.py_attribute_ref(child, "call", ctx);
						},
						_ => self.walk(child, ctx),
					}
				}
			},
			"string" => self.walk_string(node, ctx),
			"type" => self.py_type(node, ctx),
			"import_statement" | "import_from_statement" => {
				let mut cursor = node.walk();
				let names = node
					.children_by_field_name("name", &mut cursor)
					.collect::<Vec<_>>();
				for imported in names {
					let dotted = if imported.kind() == "aliased_import" {
						imported.child_by_field_name("name").unwrap_or(imported)
					} else {
						imported
					};
					let leaf = kids(dotted)
						.into_iter()
						.rfind(|c| c.kind() == "identifier")
						.unwrap_or(dotted);
					self.add_node_ref(leaf, "import", ctx);
				}
			},
			_ => self.walk_children(node, ctx, None),
		}
	}

	fn py_attribute_ref(
		&mut self,
		node: Node<'_>,
		kind: &'static str,
		ctx: Ctx<'a>,
	) -> Option<&'a str> {
		if let Some(object) = node.child_by_field_name("object") {
			if object.kind() == "identifier" && upper_first(self.text(object)) {
				self.add_node_ref(object, "type", ctx);
			} else {
				self.walk(object, ctx);
			}
		}
		let leaf = node.child_by_field_name("attribute")?;
		self.add_node_ref(leaf, kind, ctx);
		Some(self.text(leaf))
	}

	/// Type annotations: capitalised names only, which skips builtins like
	/// `int` and `str`.
	fn py_type(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		match node.kind() {
			"identifier" => {
				if upper_first(self.text(node)) {
					self.add_node_ref(node, "type", ctx);
				}
			},
			"attribute" => {
				if let Some(leaf) = node.child_by_field_name("attribute")
					&& upper_first(self.text(leaf))
				{
					self.add_node_ref(leaf, "type", ctx);
				}
			},
			_ => {
				for child in kids(node).into_iter().filter(|c| c.is_named()) {
					self.py_type(child, ctx);
				}
			},
		}
	}

	fn py_docstring(&self, node: Node<'_>) -> Option<String> {
		let body = node.child_by_field_name("body")?;
		let first = body.named_child(0)?;
		if first.kind() != "expression_statement" {
			return None;
		}
		let string = first.named_child(0).filter(|s| s.kind() == "string")?;
		let raw = self
			.text(string)
			.trim_start_matches(|c: char| c.is_ascii_alphabetic());
		let quote_len = if raw.starts_with("\"\"\"") || raw.starts_with("'''") {
			3
		} else {
			1
		};
		let inner = raw.get(quote_len..raw.len().checked_sub(quote_len)?)?;
		let doc = collapse(inner, MAX_DOC_CHARS);
		(!doc.is_empty()).then_some(doc)
	}

	// ── Go ──────────────────────────────────────────────────────────────

	fn walk_go(&mut self, node: Node<'_>, ctx: Ctx<'a>) {
		let name = node.child_by_field_name("name");
		match node.kind() {
			"function_declaration" => {
				self.define(node, name, "function", ctx);
			},
			"method_declaration" => {
				self.define(node, name, "method", ctx);
			},
			"type_alias" => {
				self.define(node, name, "type", ctx);
			},
			"type_spec" => {
				let ty = node.child_by_field_name("type");
				let kind = match ty.map(|t| t.kind()) {
					Some("struct_type") => "struct",
					Some("interface_type") => "interface",
					_ => "type",
				};
				let sig_end = ty.map(|t| {
					kids(t)
						.into_iter()
						.find(|c| matches!(c.kind(), "{" | "field_declaration_list"))
						.map_or_else(|| t.end_byte(), |c| c.start_byte())
				});
				let name_text = name.map(|n| self.text(n));
				self.define_as(
					node,
					outer_of(node),
					name_text,
					name.map(|n| n.id()),
					sig_end,
					kind,
					ctx,
				);
			},
			"call_expression" => {
				let function = node.child_by_field_name("function");
				let callee = match function {
					Some(f) if f.kind() == "identifier" => {
						self.add_node_ref(f, "call", ctx);
						Some(self.text(f))
					},
					Some(f) if f.kind() == "selector_expression" => {
						if let Some(operand) = f.child_by_field_name("operand") {
							self.walk(operand, ctx);
						}
						let field = f.child_by_field_name("field");
						if let Some(field) = field {
							self.add_node_ref(field, "call", ctx);
						}
						field.map(|f| self.text(f))
					},
					Some(f) => {
						self.walk(f, ctx);
						None
					},
					None => None,
				};
				self.walk_children(node, Ctx { scope: ctx.scope, callee }, function.map(|f| f.id()));
			},
			"composite_literal" => {
				let ty = node.child_by_field_name("type");
				if let Some(ty) = ty {
					match ty.kind() {
						"type_identifier" => self.add_node_ref(ty, "construct", ctx),
						"qualified_type" => {
							if let Some(leaf) = ty.child_by_field_name("name") {
								self.add_node_ref(leaf, "construct", ctx);
							}
						},
						_ => self.walk(ty, ctx),
					}
				}
				self.walk_children(node, ctx, ty.map(|t| t.id()));
			},
			"interpreted_string_literal" => self.walk_string(node, ctx),
			"type_identifier" => self.add_node_ref(node, "type", ctx),
			"qualified_type" => {
				if let Some(leaf) = name {
					self.add_node_ref(leaf, "type", ctx);
				}
			},
			"import_spec" => {
				if let Some(path) = node.child_by_field_name("path") {
					let text = self.text(path).trim_matches(['"', '`']);
					let leaf = text.rsplit('/').next().unwrap_or(text);
					self.add_ref(leaf, path, "import", ctx);
				}
			},
			_ => self.walk_children(node, ctx, None),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn extract(code: &str, path: &str) -> SymbolResult {
		extract_symbols(SymbolOptions {
			code: code.to_string(),
			lang: None,
			path: Some(path.to_string()),
		})
		.unwrap()
	}

	fn find<'r>(result: &'r SymbolResult, name: &str, kind: &str) -> &'r CodeSymbol {
		result
			.symbols
			.iter()
			.find(|s| s.name == name && s.kind == kind)
			.unwrap_or_else(|| panic!("missing {kind} {name}: {:?}", result.symbols))
	}

	fn has_ref(result: &SymbolResult, name: &str, kind: &str, callee: Option<&str>) -> bool {
		result
			.refs
			.iter()
			.any(|r| r.name == name && r.kind == kind && r.callee.as_deref() == callee)
	}

	const ACTIX: &str =
		"use crate::events::{E3Requested, CommitteeFinalized};\n\n/// Selects \
		 ciphernodes.\n#[derive(Debug)]\npub struct CiphernodeSelector {\n\tbus: \
		 BusHandle,\n}\n\nimpl Handler<TypedEvent<E3Requested>> for CiphernodeSelector {\n\ttype \
		 Result = ();\n\n\tfn handle(&mut self, msg: TypedEvent<E3Requested>, ctx: &mut \
		 Self::Context) {\n\t\tself.bus.publish(CommitteeFinalized { e3_id }, ctx);\n\t\tmatch msg \
		 {\n\t\t\tInterfoldEventData::E3Requested(d) => {}\n\t\t\tInterfoldEventData::Failed { \
		 reason, .. } => {}\n\t\t\t_ => {}\n\t\t}\n\t}\n}\n";

	#[test]
	fn rust_actix_handler() {
		let result = extract(ACTIX, "selector.rs");
		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("rust"));

		let imp = find(&result, "CiphernodeSelector", "impl");
		assert_eq!(imp.impl_trait.as_deref(), Some("Handler<TypedEvent<E3Requested>>"));
		assert_eq!(imp.impl_for.as_deref(), Some("CiphernodeSelector"));
		assert_eq!(imp.start_line, 9);
		assert_eq!(imp.end_line, 20);
		assert_eq!(imp.signature, "impl Handler<TypedEvent<E3Requested>> for CiphernodeSelector");

		let imp_index = result
			.symbols
			.iter()
			.position(|s| std::ptr::eq(s, imp))
			.unwrap() as u32;
		let handle = find(&result, "handle", "method");
		assert_eq!(handle.parent, Some(imp_index));
		assert_eq!(handle.start_line, 12);

		let strukt = find(&result, "CiphernodeSelector", "struct");
		assert_eq!(strukt.doc.as_deref(), Some("Selects ciphernodes."));
		assert_eq!(strukt.signature, "pub struct CiphernodeSelector");

		assert!(has_ref(&result, "CommitteeFinalized", "construct", Some("publish")));
		assert!(has_ref(&result, "publish", "call", None));
		assert!(has_ref(&result, "E3Requested", "path", None));
		assert!(has_ref(&result, "Failed", "path", None));
		assert!(has_ref(&result, "InterfoldEventData", "type", None));
		assert!(has_ref(&result, "E3Requested", "import", None));
		assert!(has_ref(&result, "E3Requested", "type", None));

		let publish = result.refs.iter().find(|r| r.name == "publish").unwrap();
		let handle_index = result
			.symbols
			.iter()
			.position(|s| std::ptr::eq(s, handle))
			.unwrap() as u32;
		assert_eq!(publish.scope, Some(handle_index));
	}

	#[test]
	fn solidity_event_and_emit() {
		let code = "pragma solidity ^0.8.0;\nimport {IFoo} from \"./IFoo.sol\";\n\n/// Registry of \
		            things.\ncontract Registry is Ownable, IFoo {\n\tevent Registered(address \
		            indexed who);\n\terror Bad(uint256 a);\n\tuint256 public \
		            total;\n\n\tconstructor() Ownable() {}\n\n\tfunction register(address who) \
		            external onlyOwner {\n\t\temit Registered(who);\n\t\trevert Bad(1);\n\t}\n}\n";
		let result = extract(code, "Registry.sol");
		assert!(result.parsed);
		let contract = find(&result, "Registry", "contract");
		assert_eq!(contract.impl_trait.as_deref(), Some("Ownable, IFoo"));
		assert_eq!(contract.doc.as_deref(), Some("Registry of things."));
		let contract_index = result
			.symbols
			.iter()
			.position(|s| std::ptr::eq(s, contract))
			.unwrap() as u32;
		let event = find(&result, "Registered", "event");
		assert_eq!(event.parent, Some(contract_index));
		assert_eq!(event.signature, "event Registered(address indexed who);");
		find(&result, "Bad", "error");
		find(&result, "total", "variable");
		find(&result, "constructor", "function");
		let register = find(&result, "register", "function");
		assert_eq!(register.signature, "function register(address who) external onlyOwner");
		assert!(has_ref(&result, "Registered", "emit", None));
		assert!(has_ref(&result, "IFoo", "import", None));
		assert!(has_ref(&result, "IFoo", "type", None));
		assert!(has_ref(&result, "onlyOwner", "call", None));
		assert!(has_ref(&result, "Bad", "call", None));
	}

	#[test]
	fn typescript_class_with_jsdoc() {
		let code = "import { Base, type Opts } from './base';\n\n/**\n * Runs jobs.\n * Second \
		            line.\n */\nexport class Runner extends Base implements Disposable, \
		            Runnable<Opts> {\n\t/** Start it. */\n\tasync start(opts: Opts): Promise<void> \
		            {\n\t\tbus.publish(new Started(opts));\n\t}\n}\n\nexport const make = (a: \
		            number) => new Runner(a);\nconst hidden = 1;\nexport const LIMIT = 5;\n";
		let result = extract(code, "runner.ts");
		assert!(result.parsed);
		let class = find(&result, "Runner", "class");
		assert_eq!(class.doc.as_deref(), Some("Runs jobs. Second line."));
		assert_eq!(class.impl_trait.as_deref(), Some("Base, Disposable, Runnable<Opts>"));
		assert_eq!(class.start_line, 7);
		assert_eq!(
			class.signature,
			"export class Runner extends Base implements Disposable, Runnable<Opts>"
		);
		let class_index = result
			.symbols
			.iter()
			.position(|s| std::ptr::eq(s, class))
			.unwrap() as u32;
		let start = find(&result, "start", "method");
		assert_eq!(start.parent, Some(class_index));
		assert_eq!(start.doc.as_deref(), Some("Start it."));
		assert_eq!(start.signature, "async start(opts: Opts): Promise<void>");
		assert_eq!(find(&result, "make", "function").signature, "export const make = (a: number) =>");
		find(&result, "LIMIT", "const");
		assert!(result.symbols.iter().all(|s| s.name != "hidden"));
		assert!(has_ref(&result, "Started", "construct", Some("publish")));
		assert!(has_ref(&result, "publish", "call", None));
		assert!(has_ref(&result, "Base", "import", None));
		assert!(has_ref(&result, "Base", "type", None));
		assert!(has_ref(&result, "Runner", "construct", None));
	}

	#[test]
	fn python_and_go() {
		let py = extract(
			"class A(B):\n\t\"\"\"Doc here.\"\"\"\n\tdef f(self, x: Foo):\n\t\treturn g(Bar(x))\n",
			"a.py",
		);
		assert!(py.parsed);
		assert_eq!(find(&py, "A", "class").doc.as_deref(), Some("Doc here."));
		assert_eq!(find(&py, "A", "class").impl_trait.as_deref(), Some("B"));
		find(&py, "f", "method");
		assert!(has_ref(&py, "Bar", "call", Some("g")));
		assert!(has_ref(&py, "Foo", "type", None));

		let go = extract(
			"package main\n\n// Foo is a thing.\ntype Foo struct{ A int }\n\nfunc (f *Foo) M(a Bar) \
			 {\n\tg(Baz{})\n}\n",
			"a.go",
		);
		assert!(go.parsed);
		let foo = find(&go, "Foo", "struct");
		assert_eq!(foo.doc.as_deref(), Some("Foo is a thing."));
		assert_eq!(foo.signature, "type Foo struct");
		find(&go, "M", "method");
		assert!(has_ref(&go, "Baz", "construct", Some("g")));
		assert!(has_ref(&go, "Bar", "type", None));
	}

	#[test]
	fn rust_wrapped_publish_and_constructor_calls() {
		let code = "fn run() {\n\taddr.send(TypedEvent::new(AggregationProofSigned { id \
		            }));\n\tbus.publish(Ev::Started(x));\n\tbus.publish(Box::new(Wrapper(y)).\
		            into());\n\tother(Some(Plain { z }));\n}\n";
		let result = extract(code, "a.rs");
		assert!(has_ref(&result, "AggregationProofSigned", "construct", Some("send")));
		assert!(has_ref(&result, "TypedEvent", "type", Some("send")));
		assert!(has_ref(&result, "new", "call", Some("send")));
		assert!(has_ref(&result, "Started", "construct", Some("publish")));
		assert!(has_ref(&result, "Wrapper", "construct", Some("publish")));
		assert!(has_ref(&result, "Plain", "construct", Some("other")));
		assert!(!has_ref(&result, "Started", "call", Some("publish")));
	}

	#[test]
	fn long_receiver_chains_stay_within_a_small_stack() {
		let inputs = [
			(format!("const v = x{};", ".a()".repeat(5000)), "a.ts"),
			(format!("y{}", ".a".repeat(8000)), "a.py"),
			(format!("fn f() {{ let v = x{}; }}", ".a()".repeat(5000)), "a.rs"),
			(format!("package p\nfunc f() {{ _ = x{} }}", ".a()".repeat(5000)), "a.go"),
		];
		// A small worker stack, like the libuv thread that runs extraction in
		// production (debug frames are ~4x release).
		std::thread::Builder::new()
			.stack_size(4 * 1024 * 1024)
			.spawn(move || {
				for (code, path) in inputs {
					assert!(extract(&code, path).parsed, "{path}");
				}
			})
			.unwrap()
			.join()
			.unwrap();
	}

	#[test]
	fn unknown_language_is_unparsed() {
		for (code, path) in [("{}", "a.unknown"), ("key: value", "a.yaml"), ("fn main() {}", "noext")]
		{
			let result = extract(code, path);
			assert!(!result.parsed);
			assert!(result.symbols.is_empty() && result.refs.is_empty());
		}
		let by_lang = extract_symbols(SymbolOptions {
			code: "fn main() {}".to_string(),
			lang: Some("not-a-language".to_string()),
			path: Some("a.rs".to_string()),
		})
		.unwrap();
		assert!(!by_lang.parsed);
	}

	#[test]
	fn noir_is_walked_with_the_rust_grammar() {
		let code = "fn main(x: Field, y: pub Field) -> pub Field {\n\tassert(x != \
		            y);\n\thelper(x)\n}\n\nstruct S {\n\ta: Field,\n}\n\nglobal N: u32 = 3;\n";
		for (lang, path) in
			[(None, Some("main.nr")), (Some("noir"), None), (Some("nr"), Some("a.rs"))]
		{
			let result = extract_symbols(SymbolOptions {
				code: code.to_string(),
				lang: lang.map(str::to_string),
				path: path.map(str::to_string),
			})
			.unwrap();
			assert!(result.parsed);
			assert_eq!(result.language.as_deref(), Some("noir"));
			assert_eq!(find(&result, "main", "function").start_line, 1);
			find(&result, "S", "struct");
			assert!(has_ref(&result, "helper", "call", None));
			assert!(has_ref(&result, "assert", "call", None));
		}
		let global = extract(code, "main.nr");
		let n = find(&global, "N", "const");
		assert_eq!((n.start_line, n.end_line), (10, 10));
		let more =
			extract("pub global M: Field = 1;\nglobal ARR: [Field; 2] = [1, 2];\nfn f() {}\n", "a.nr");
		find(&more, "M", "const");
		find(&more, "ARR", "const");
		find(&more, "f", "function");
		// `global` is an ordinary identifier outside Noir.
		let rust = extract("fn f() { let global = 1; g(global); }\n", "a.rs");
		assert!(rust.symbols.iter().all(|s| s.kind != "const"));
	}

	#[test]
	fn rust_paths_emit_every_uppercase_qualifier() {
		let code = "fn decode(topics: &[B256], data: &[u8]) {\n\tmatch topics.first() \
		            {\n\t\tSome(&ICiphernodeRegistry::SortitionCommitteeFinalized::SIGNATURE_HASH) \
		            => {\n\t\t\tlet e = \
		            ICiphernodeRegistry::SortitionCommitteeFinalized::decode_log_data(data);\n\t\t}\\
		            \
		            n\t\t_ => {}\n\t}\n}\n";
		let result = extract(code, "events.rs");
		assert!(has_ref(&result, "ICiphernodeRegistry", "type", None));
		assert!(has_ref(&result, "SortitionCommitteeFinalized", "type", None));
		assert!(has_ref(&result, "decode_log_data", "call", None));
		assert!(has_ref(&result, "SIGNATURE_HASH", "path", None));
		// Lowercase module segments are skipped; deeper uppercase ones are kept.
		let nested = extract("fn f() { e3_events::inner::Ev::Kind::go(); }\n", "a.rs");
		assert!(has_ref(&nested, "Ev", "type", None));
		assert!(has_ref(&nested, "Kind", "type", None));
		assert!(
			nested
				.refs
				.iter()
				.all(|r| r.name != "e3_events" && r.name != "inner")
		);
	}

	#[test]
	fn name_like_string_literals_are_recorded() {
		let rust = extract(
			"fn name(c: C) -> &'static str {\n\tlet m = \"Error parsing event\";\n\tmatch c \
			 {\n\t\tC::A => \"share_decryption\",\n\t\tC::B => \"threshold\",\n\t\t_ => \
			 \"ab\",\n\t}\n}\n",
			"proof.rs",
		);
		assert!(has_ref(&rust, "share_decryption", "string", None));
		assert!(has_ref(&rust, "threshold", "string", None));
		assert!(
			!rust
				.refs
				.iter()
				.any(|r| r.name == "Error parsing event" || r.name == "ab")
		);

		let noir = extract("fn main() { std::println(\"x\"); foo(\"circuit_name\"); }\n", "main.nr");
		assert!(has_ref(&noir, "circuit_name", "string", Some("foo")));

		let ts = extract("run('share_decryption', \"not a name\", './rel/path');\n", "a.ts");
		assert!(has_ref(&ts, "share_decryption", "string", Some("run")));
		assert!(
			ts.refs
				.iter()
				.all(|r| r.kind != "string" || r.name == "share_decryption")
		);

		let sol = extract(
			"contract A {\n\tfunction f() external {\n\t\tg(\"ciphernode-registry\");\n\t}\n}\n",
			"A.sol",
		);
		assert!(has_ref(&sol, "ciphernode-registry", "string", Some("g")));

		let py = extract("def f():\n\tg('share_decryption', f'{h()}')\n", "a.py");
		assert!(has_ref(&py, "share_decryption", "string", Some("g")));
		assert!(has_ref(&py, "h", "call", Some("g")));

		let go = extract("package p\nfunc f() { g(\"share_decryption\") }\n", "a.go");
		assert!(has_ref(&go, "share_decryption", "string", Some("g")));
	}
}
