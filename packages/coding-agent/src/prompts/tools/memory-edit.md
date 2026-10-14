Edit Mnemopi long-term memories by id. Only ids returned by `{{toolRefs.recall}}`.

Operations:
- `update`: working memory; replace content and/or importance.
- `forget`: {{#if permanentRetention}}retire working or episodic memory from recall; the row is kept, because retention is permanent{{else}}permanently delete working memory{{/if}}.
- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.

Fact ids — `{{toolRefs.recall}}` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.

Prefer `invalidate` for stale memory whose history may still be useful.{{#unless permanentRetention}} Use `forget` only for content requiring hard deletion.{{/unless}}

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.
{{#if provenanceRules}}

Memories pinned or retracted by the owner cannot be changed by any op: leave them, and tell the owner if one looks wrong. `update` applies only to memories you wrote yourself, not to the owner's words or text from outside; invalidate those and retain a corrected memory.
{{/if}}
