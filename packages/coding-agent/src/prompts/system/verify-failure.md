<system-reminder>
The harness ran your configured verification step after your file changes, and it failed. This message is automated; it did not come from the user.
Command: `{{command}}`
Result: {{status}}
Attempt {{attempt}}/{{maxAttempts}}. Fix the cause and finish the task; verification reruns after you change files again.
{{#if output}}

Output{{#if truncatedChars}} (last {{outputChars}} characters; {{truncatedChars}} earlier characters omitted){{/if}}:
```
{{output}}
```
{{/if}}
</system-reminder>
