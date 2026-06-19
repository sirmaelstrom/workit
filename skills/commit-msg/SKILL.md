---
name: commit-msg
description: "This skill should be used when composing a git commit message that contains shell-active characters — backticks (code refs), markdown links, quotes, or any content that breaks under HEREDOC shell parsing. Invoked by '/commit-msg', or whenever the drafted commit message has any of: backticks, markdown links, embedded quotes, multi-line code blocks, or other characters the outer shell could re-parse. Writes the message to .git/COMMIT_EDITMSG and commits via 'git commit -F' so the shell never sees the message body."
---

# commit-msg — File-based git commit

The HEREDOC pattern `git commit -m "$(cat <<'EOF' ... EOF)"` works for plain text but breaks on shell-active content in the body: backticks trigger command substitution under the outer `$(...)`, embedded quotes can break the wrapping, and escape sequences get re-interpreted. File-based commits via `git commit -F <file>` bypass shell parsing of the message entirely.

## Repository context (injected at load time)

The two read-only git reads below run automatically when this skill loads, so the staged changes and recent history are already in front of you before you compose — no separate status/log round-trip needed. (This uses Claude Code's load-time shell injection. If you would rather not run shell when a skill loads, set `disableSkillShellExecution` to true in settings.json; the skill still works without it via the fallback note below.)

**Staged / working-tree status:**
!`git status --short 2>/dev/null || echo "(no staged changes, or not a git repo - run git status yourself)"`

**Recent commits (prefix + style reference):**
!`git log --oneline -10 2>/dev/null || echo "(no commit history - run git log yourself)"`

If either block shows the parenthetical placeholder instead of real output (kill switch on, or not a git repo), just run the command yourself at the step below. The injection is an accelerant, not a dependency.

## When to invoke

Invoke when **any** of these hold:

- The user explicitly says `/commit-msg`, "use file-based commit", or similar.
- The drafted message contains backticks (e.g. `` `parseConfig()` ``, `` `--no-verify` ``, command refs).
- The message contains markdown links `[text](url)`.
- The message contains embedded double or single quotes.
- The message contains a code fence or multi-line code block.
- The message is multi-paragraph with formatting you want to land verbatim.

For plain prose with no shell-active characters, the standard HEREDOC pattern is fine — don't spin up a file for those.

## Workflow

### 1. Verify there is something to commit

The staged status is injected above under "Repository context" — use it. If that block shows the placeholder (or you need a fresh read), run `git status --short` yourself. If nothing is staged and the user did not explicitly request `git commit -a`, stop and report. Do not create empty commits.

### 2. Compose the message

Draft based on the staged diff plus user intent. Conventions:

- Match the repository's prefix style — the recent commits are injected above under "Repository context." If that block is placeholder or absent, run `git log --oneline -10` yourself (e.g. `feat:`, `fix:`, `docs(readme):`, `chore(ci):`).
- Subject line under 70 chars.
- Body explains WHY, not WHAT. Skip mechanics the diff already shows.
- Exclude internal review scaffolding from the message body (iteration/wave markers, reviewer names, PR thread IDs, "addressed feedback from…"). Write the message as the squashed, durable record of the change.
- If the repo has an AI-attribution convention (a trailer or marker), follow it; otherwise don't invent one.

### 3. Write to `.git/COMMIT_EDITMSG`

Use the Write tool to put the full message into `<repo_root>/.git/COMMIT_EDITMSG`. This is git's own scratchpad — it gets overwritten on the next commit anyway, so no cleanup is required.

If the working directory is not the repo root, run `git rev-parse --show-toplevel` first to find the right path.

### 4. Commit

```
git commit -F .git/COMMIT_EDITMSG
```

If a pre-commit hook fails, fix the underlying issue and create a NEW commit. Do not amend, do not bypass with `--no-verify`.

### 5. Verify

```
git log -1 --format='%h %s%n%n%b'
```

Confirm the message rendered exactly as drafted. Look for literal backslashes, broken markdown, missing lines, or character substitutions that suggest shell parsing leaked in somewhere.

## When NOT to use

- Plain ASCII prose with no shell-active characters — HEREDOC is fine, no need to spin up a file.
- `git tag -m` / `git notes add` — those have their own `-F` mechanisms; the principle is the same but the commands differ.
- Amending an existing commit at the user's explicit request — use `git commit --amend -F .git/COMMIT_EDITMSG` with the same file-write step.

## Why this exists

Recurring pattern: HEREDOC-based commit messages with backticks, markdown links, and embedded quotes cause `git commit --amend` cycles when the outer shell re-parses content that should have been literal. File-based commits eliminate the entire class of shell-parsing bugs — write the message to a file, hand git the file, and the shell never touches the body.
