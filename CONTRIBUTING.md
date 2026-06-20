# Contributing to workit

Thanks for your interest. This is an opinionated personal toolkit published as a
worked example as much as a drop-in plugin — contributions, forks, and issues are
all welcome.

## Development

- **Requirements:** Node 24+ (the scripts use `node:` built-ins, including `node:sqlite`). No install step — there are no third-party dependencies.
- **Run the tests:** `node --test` from the repo root. All tests must pass before a PR is merged; CI runs the same command plus a `gitleaks` secret scan.
- **Skills** live under `skills/<id>/SKILL.md`; the methodology they draw on is in `reference/`.

## Commit messages

This repo dogfoods its own `commit-msg` skill: commits are composed via
`git commit -F` so shell-active content (backticks, links, quotes) lands verbatim.
Keep messages descriptive; explain the *why*, not just the *what*.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Make sure `node --test` is green and the secret scan passes.
- Be civil — see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
