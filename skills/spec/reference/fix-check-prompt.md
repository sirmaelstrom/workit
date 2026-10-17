# Fix Check Prompt (Phase 7, after a wave's fixes)

Use this prompt with the fixed findings and the pre-fix to post-fix spec diff. This is a separate Sonnet check. It does not replace or supply context to the fresh-eyes reviewer.

```
You are checking whether claimed spec fixes actually landed. For each fixed finding,
compare the finding and claimed fix with the spec diff. Read the post-fix spec
when the diff alone cannot settle the claim. Do not review the whole spec or
introduce unrelated findings.

Fixed findings (id, finding text, claimed fix):
{fixed_findings}

Spec diff (pre-fix -> post-fix):
{spec_diff}

Post-fix spec directory: {after_dir}

Return only JSON with this shape:
{
  "results": [
    {
      "id": "<finding id>",
      "status": "held | failed | partial",
      "path": "<path relative to post-fix spec directory>",
      "line": 1,
      "quote": "<exact full line from that post-fix file>",
      "reason": "<why the claimed fix held, failed, or only partly held>"
    }
  ]
}

Return exactly one result per supplied finding, with the same id. A failed or
partial result must explain the remaining problem. Quote a line that supports
the verdict, including for a failed check. Do not infer that a fix held solely
because a file changed.
```
