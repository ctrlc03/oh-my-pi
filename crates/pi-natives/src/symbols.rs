//! Symbol and reference extraction powered by tree-sitter.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

#[napi(object)]
pub struct SymbolOptions {
	/// Source code to index.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
}

#[napi(object)]
pub struct CodeSymbol {
	/// Bare identifier: "handle", "CiphernodeSelector", "E3Requested".
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

#[napi(object)]
pub struct SymbolRef {
	/// Last identifier of the referenced path.
	pub name:   String,
	/// 1-indexed line.
	pub line:   u32,
	/// "call" | "type" | "construct" | "import" | "emit" | "macro" | "path" |
	/// "string" (a name-like string literal).
	pub kind:   String,
	/// Index into `symbols` of the innermost enclosing symbol.
	pub scope:  Option<u32>,
	/// Last identifier of the innermost call whose argument list contains this
	/// reference.
	pub callee: Option<String>,
}

#[napi(object)]
pub struct SymbolResult {
	/// Canonical language name when parsing succeeded ("noir" for `.nr`
	/// sources, which are parsed with the Rust grammar).
	pub language: Option<String>,
	/// True when the language is supported and tree-sitter produced a tree.
	pub parsed:   bool,
	/// Definitions in source order.
	pub symbols:  Vec<CodeSymbol>,
	/// References in source order.
	pub refs:     Vec<SymbolRef>,
}

impl From<pi_ast::symbols::CodeSymbol> for CodeSymbol {
	fn from(value: pi_ast::symbols::CodeSymbol) -> Self {
		Self {
			name:       value.name,
			kind:       value.kind,
			start_line: value.start_line,
			end_line:   value.end_line,
			signature:  value.signature,
			doc:        value.doc,
			parent:     value.parent,
			impl_trait: value.impl_trait,
			impl_for:   value.impl_for,
		}
	}
}

impl From<pi_ast::symbols::SymbolRef> for SymbolRef {
	fn from(value: pi_ast::symbols::SymbolRef) -> Self {
		Self {
			name:   value.name,
			line:   value.line,
			kind:   value.kind,
			scope:  value.scope,
			callee: value.callee,
		}
	}
}

impl From<pi_ast::symbols::SymbolResult> for SymbolResult {
	fn from(value: pi_ast::symbols::SymbolResult) -> Self {
		Self {
			language: value.language,
			parsed:   value.parsed,
			symbols:  value.symbols.into_iter().map(Into::into).collect(),
			refs:     value.refs.into_iter().map(Into::into).collect(),
		}
	}
}

fn extract(options: SymbolOptions) -> Result<SymbolResult> {
	pi_ast::symbols::extract_symbols(pi_ast::symbols::SymbolOptions {
		code: options.code,
		lang: options.lang,
		path: options.path,
	})
	.map(Into::into)
	.map_err(|error| Error::from_reason(error.to_string()))
}

/// Extract symbols and references synchronously on the calling thread.
///
/// Prefer [`extract_symbols_async`] on hot paths: the tree-sitter parse blocks
/// the JS thread for the whole call.
#[napi]
pub fn extract_symbols(options: SymbolOptions) -> Result<SymbolResult> {
	extract(options)
}

/// Extract symbols and references on libuv's thread pool.
///
/// Same result as [`extract_symbols`], but the parse and walk run off the JS
/// thread; only argument and result marshalling happen on it.
#[napi]
pub fn extract_symbols_async(options: SymbolOptions) -> task::Promise<SymbolResult> {
	task::blocking("extract_symbols", (), move |_| extract(options))
}
