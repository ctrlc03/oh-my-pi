# This is a map of a change

You are mapping what {{target}} changes compared with `{{baseTarget}}` (base commit `{{baseCommit}}`), not the whole system. The base checkout is at `{{baseDir}}`, read-only like your working directory (which is the changed version): read it for things that were removed or that looked different before.

- The root diagram `system` is titled **What changed**. It shows the components and flows the change touches, with their neighbours drawn plainly for context. Mark every node and edge the change touches with `"change": "added"`, `"modified"` or `"removed"`; leave unchanged context unmarked. A removed node or edge is drawn too, marked `removed`.
- Component diagrams cover only components the change touches, and mark the same way.
- Refs of something **removed** point at the base version: write them with a leading side marker, `base:path@line@token` (the path and line are those of the base checkout). Refs of everything else point at the changed version.
- In the summary of a changed node say what changed in plain words ("now retries failed payments"), not how many lines moved.
- The generated folder, file and symbol levels already carry the change marks; link your nodes into them with `child` paths as usual.

Changed files, as `git diff --stat` shows them:

```
{{stat}}
```

Changed symbols (from the code index):

{{symbols}}
