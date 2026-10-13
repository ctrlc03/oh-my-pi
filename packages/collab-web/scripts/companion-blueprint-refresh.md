# This is an update of an earlier map

An earlier version of this map was drawn at commit `{{previousCommit}}`. Read it first: `{{previousFile}}` (JSON in the same format, only its agent-written diagrams). Since then the code changed like this:

```
{{stat}}
```

Update only the diagrams the change affects, and reuse the rest as they are:

- In the output, put every diagram you write or rewrite in `diagrams`, as in the format above.
- List the ids of earlier diagrams that are still right in `"keep": ["comp-api", ...]`; they are carried over unchanged (their citations are re-checked against the new commit and corrected where lines moved).
- Anything in neither list is removed. The root diagram `system` must be in one of the two lists. A diagram you keep must not have a node whose `child` points at a diagram you removed.
- Check the citations of the diagrams you keep that touch the changed files; rewrite those diagrams if what they cite is gone.
