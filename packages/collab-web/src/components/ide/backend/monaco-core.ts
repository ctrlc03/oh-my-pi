/**
 * The slice of Monaco the editor uses: the standalone editor API plus the contributions behind VS Code's
 * everyday behaviour (find and replace, multi-cursor, folding, bracket matching, line operations, the command
 * palette, hover and problem widgets). It stands in for `monaco-editor`'s own `editor.main`, which also
 * registers the CSS, HTML, JSON and TypeScript language services (and their workers): the language server does
 * that job here, and Monaco keeps only its Monarch tokenizers (see `monaco-languages.ts`).
 *
 * Imports go through the package's `exports` map (`./*` is `esm/vs/*.js`), which is why the specifiers
 * carry no `esm/vs`.
 */
import "monaco-editor/features/codicon/register.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/editor/common/standaloneStrings.js";

export {
	CancellationTokenSource,
	Emitter,
	editor,
	KeyCode,
	KeyMod,
	languages,
	MarkerSeverity,
	Position,
	Range,
	Selection,
	Uri,
} from "monaco-editor/editor/editor.api.js";
