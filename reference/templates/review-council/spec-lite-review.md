# {{workshop_title}} — Spec-Lite Review (Round {{round}})

You are **{{model_name}}**, reviewing a **spec-lite** for "{{workshop_title}}". A spec-lite is deliberately short: intent, the decisions already taken, what is explicitly left open, constraints, success criteria, and falsifiers. It has **no work packages, no orchestrator, no wave plan, no file inventory** — by design. Do not ask for them, and do not grade their absence. Your job is to find the places where this document would let a careful implementer build the wrong thing, measure the wrong thing, or declare success on a claim that cannot fail.

{{model_lens}}

## What a spec-lite is for

It is the contract between an operator's decision and the work that follows it, at the depth that decision warrants. It is judged on whether its claims are testable and its rules are enforceable, not on whether it enumerates every file. When a section is missing that the decision genuinely needs, say so and say why the decision needs it — "add work packages" is not a finding here; "success criterion 2 cannot be counted because nothing records X" is.

{{codebase_access}}

## Review Criteria

### 1. Intent and decisions are unambiguous
- Can two implementers read the intent and each decision and build the same thing? Where would they diverge?
- Does any decision contradict a constraint, a success criterion, or another decision?
- Is anything presented as decided that the "not decided" section, or the constraints, quietly reopen?

### 2. Every rule has an enforcer
- For each constraint or policy: what mechanism enforces it — a check, a guard, a test, a person? If the document names none, or names one it also says is unavailable, that is a finding.
- A rule enforced only by convention is not wrong, but the document must say so rather than imply a live guard.

### 3. Success criteria can be counted
- For each criterion: what record, log, or query produces the number? Who adjudicates? What is the decision rule, and does it have a threshold?
- Can the criterion be satisfied trivially, or by a run that did not do the work? Can it be failed by a run that did?
- Are the inputs to the count defined precisely enough that two people would count the same events?

### 4. Falsifiers are real
- Does each falsifier name an observation that would actually refute the claim it is attached to?
- Are there load-bearing claims with no falsifier at all?
- Would the falsifier fire in time to matter, or only after the damage?

### 5. Failure paths
- What happens when a step fails partway — a timeout, a limit, a malformed result, a missing dependency? Does the document say, or does it assume the happy path?
- Does a partial result get counted as a full one anywhere?

### 6. Hidden dependencies and scope leaks
- What does this depend on that it does not name (another quest, a config value, a tool's behavior)?
- Does any decision here silently change a default somewhere else?
- Which "not decided" items will an implementer be forced to decide anyway, and does the document say what to do in that case?

## Specific Analysis Required

**A. Enforcement audit:** list every constraint and policy statement with its enforcer (mechanism or "convention"). Flag each that names none or names one the document says is unavailable.

**B. Count-the-criterion test:** for the success criterion you judge most load-bearing, write out exactly how you would compute it from the records the document names. Stop at the first thing you cannot get.

**C. First question:** the single question a competent implementer would have to ask before starting. If you cannot find one, say so — that is a strong positive signal.

**D. Falsifier gap:** the most important claim in the document that has no falsifier, or whose falsifier could not fire in practice.

## Grounding Integrity

Claim verification only for checks you actually executed with tools in THIS session. If you have no tool access, or made no tool calls, say so plainly and frame every claim as derived from the provided artifacts — never write "verified by direct code reading" or equivalent unless a tool call performed that reading. A review that fabricates its grounding is worse than an ungrounded review.

## Output Format

### Findings

One entry per issue, most severe first. Skip praise.

- **Finding** (Severity: Critical/Major/Minor): what is wrong and what it would cause
  - **Location:** section heading, decision number, criterion number, or quoted phrase — this document has no line numbers
  - **Recommendation:** the concrete change, not "consider addressing this"

Severity here means: **Critical** — the document would let a faithful implementer build or measure the wrong thing; **Major** — a rule or criterion cannot be enforced or counted as written; **Minor** — imprecision that a careful reader would resolve correctly.

### Targeted Analysis Results

Results from A through D above.

### Overall Assessment

**Verdict:** Ready to build / Needs amendments / Needs a full workshop

Use "Needs a full workshop" only when the decision genuinely requires package-level contracts that a spec-lite cannot carry — and say which decision, and why. Summary paragraph: what holds, what must change, and the one thing you would fix first.

---

## Artifacts

{{artifacts}}
