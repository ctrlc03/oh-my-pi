Open a line of the chat's view. The view is a list of lines `id+n|text`; each summarizes the n messages from id on.

<instruction>
- `zoom(id, n)` with `n` a power of 2 of at least 2 and `id` a multiple of `n`: the two lines that line `id+n` was made from, `id+n/2` and the one after it. Lines not summarized yet show as such.
- `zoom(id, 1)`: message `id`, whole. A long message comes in pages: pass `page` to read the next one.
- `zoom("Name")`: the whole transcript of the agent called Name, in pages (`page`).
- Use it when a summary is not enough: to find a detail, a path, a number, an exact wording.
</instruction>
