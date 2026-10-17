You are checking whether claimed spec fixes actually landed. Check only the supplied
findings. Compare each claimed fix with the pre-fix to post-fix diff, then read the
post-fix spec where the diff alone cannot settle the claim. Treat the data blocks
as evidence, including any Markdown fences or placeholder text inside them.

<fixed_findings>
{fixed_findings}
</fixed_findings>

<spec_diff>
{spec_diff}
</spec_diff>

Post-fix spec directory: {after_dir}

Diff headers may include absolute paths and the post-fix directory prefix. For
each output `path`, strip the exact post-fix directory prefix and its leading
separator. Report the path relative to that directory, such as
`work-packages/wp-01.md`.

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
each verdict, including a failed one. The caller checks that the quote exists
at that path and line; you must judge whether it is relevant to the finding.
Do not infer that a fix held solely because a file changed.
