# Reviewer Archetypes

The cartographer selects 2-7 archetypes per review based on what it observes in the diff or target. It does not invent new archetypes — it picks from this menu.

Each archetype defines: what the reviewer focuses on, when to deploy it (with diff-signal triggers where possible), what severity levels it can assign, and what context it needs.

**Diff-signal triggers** are the primary mechanism for utilization. The cartographer should pattern-match against signals in the diff/target text — file extensions, content keywords, surface area — rather than relying on holistic judgment alone. Where a trigger fires, the archetype is a strong candidate.

---

## Code Quality

**Focus:** Patterns, naming, maintainability, idiomatic usage, readability.

**Deploy when:** Almost always. Skip only for pure config/text changes, or when narrower archetypes (Service Architecture, Data Integrity) cover the same surface more sharply.

**Looks for:**
- Naming that doesn't match codebase conventions
- Duplicated logic that should be extracted
- Overly complex functions (deep nesting, long parameter lists)
- Dead code, unused variables, commented-out blocks
- Language-specific idiom violations (e.g., string concatenation instead of template literals in JS/TS; format strings vs concatenation in Rust)
- Svelte 5 runes misuse: `$state` on derived values (use `$derived`), `$effect` for synchronous derivations (use `$derived`), `$effect` writing to `$state` creating reactive loops
- Swallowed errors: empty catch blocks, catch blocks that log but don't rethrow or handle, error context stripped during re-throw (`throw new Error(msg)` losing the cause chain — use `{ cause: err }`)
- Test quality: mocks that replicate implementation details (brittle to refactoring), snapshot tests on volatile output, test names that don't describe the expected behavior
- Observability gaps: operations that can fail silently with no logging or metric, unstructured error messages that resist grep/search
- Accessibility: missing semantic HTML (div-soup), interactive elements without keyboard support, missing ARIA labels on non-text content

**Context needed:** Diff + conventions (Tier 1), or diff + surrounding source (Tier 2+)

---

## Security

**Focus:** Auth, input validation, injection vectors, data exposure, access control.

**Deploy when:** **Always (mandatory floor — non-negotiable).** Security runs regardless of diff signals. Rationale: independent multi-reviewer studies (Cloudflare production system, SWR-Bench) show security concerns are the highest-cost class to miss, and reviewer-overlap on security findings is rare enough that "always-on" is the only reliable way to ensure coverage. **Strong diff signals** (always elevate severity attention): changes to authentication middleware, JWT/session/cookie handling, SQL or query string construction, input parsing, role/permission checks, CORS configuration, environment variable handling. With no signals firing, Security may legitimately return "No issues found" — that's a successful pass, not wasted compute.

**Looks for:**
- SQL or NoSQL injection vectors (string concatenation in queries, unparameterized inputs)
- Missing input validation or sanitization on endpoints
- Sensitive data in logs, error messages, or API responses
- Permission or authorization checks bypassed or missing
- Secrets, credentials, or tokens in source code or client-visible surfaces
- Insecure defaults (open CORS, disabled TLS validation, permissive CSP)
- Prototype pollution vectors (recursive merge, property assignment from user input without allowlist)
- ReDoS-vulnerable regular expressions (catastrophic backtracking on untrusted input)
- SSRF vectors (user-controlled URLs passed to fetch/http without allowlist validation)
- Path traversal (user input in file paths without sanitization — `../` sequences, null bytes)
- Environment variable leakage (secrets logged, included in error responses, or exposed via debug endpoints)
- Rust `unsafe` blocks without safety invariant documentation — each `unsafe` must document why the invariants are upheld

**Severity guidance:** Injection vectors and authorization bypasses are **always blocker**. Sensitive data exposure is **high** to **blocker** depending on sensitivity. Insecure defaults are **high**. Secrets in source are **blocker**.

**Context needed:** Diff + conventions (Tier 1), or diff + full auth flow (Tier 2+)

---

## Service Architecture

**Focus:** Shape of internal service classes — interface design, constructor surface, dependency injection patterns, premature flexibility, lifetime/scoping correctness. Distinct from API Contract (which is the HTTP surface).

**Deploy when:** New or modified service classes, service-decomposition refactors, cases where one service is split into multiple. **Diff signals:** new files in service/application layers, interface additions or renames, DI registration calls (`provide`, `Injectable`, `AddTransient`/`AddScoped`/`AddSingleton`, container bindings), constructor changes, `singleton`/`transient`/`scoped` lifetime annotations.

**Looks for:**
- **Unnecessary no-arg constructor on a DI-managed class:** Leaves injected fields null/undefined and forces null-guard patterns throughout. Drop it if the type is only ever constructed via the container.
- **Premature `virtual`/`open` without explicit justification:** Interface-based mocking is sufficient for tests in most stacks; openness-by-default creates unintended extension points.
- **Deferred-execution return types on service interfaces:** `Iterable<T>`, `AsyncIterable<T>`, `IEnumerable<T>`, or lazy sequences returned from service methods that callers will `.toArray()` / `.collect()` — the deferred-execution hazard belongs inside the implementation, not the contract. Return materialized collections.
- **Duplicate DI registrations:** Registering both the concrete type and the interface separately constructs distinct instances per scope. Register once via the interface binding.
- **Inconsistent cross-cutting behavior:** Six services in a decomposition — five instrument/log entry, one is silent. Either all do it or none; name the convention.
- **Naming divergence without documented seam:** Two naming prefixes coexist with no comment or convention file explaining which applies where.
- **Missing graceful shutdown:** Services that don't handle `SIGTERM`/`SIGINT` for connection draining, in-flight request completion, or cleanup of background tasks
- **Missing health checks:** HTTP services without a health/readiness endpoint for orchestrators (Docker, PM2, k8s)
- **Middleware ordering errors:** Auth middleware registered after route handlers, error handlers not last in the chain, CORS middleware after routes that need it
- **Connection pool misconfiguration:** Database or HTTP connection pools without max size limits, missing idle timeouts, or no connection validation
- **Unhandled async errors in middleware:** Express/Hono async route handlers that throw without an async error wrapper — unhandled rejections crash the process

**Severity guidance:** Null-field-from-missing-injection is **medium-high**. Premature openness is **medium**. Deferred-execution return on interface is **medium-high**. Duplicate registration is **medium**. Inconsistent cross-cutting is **medium**. Undocumented naming split is **medium**.

**Context needed:** Diff + (Tier 2+) full service files + DI registration module.

---

## Domain Modeling

**Focus:** Value type encapsulation, state representation, type-driven impossibility of invalid states. Distinct from Service Architecture (shape of services) and TypeScript Patterns (idiomatic type usage) — Domain Modeling is about whether the *shape of the data itself* prevents bugs.

**Deploy when:** New entity/model classes, DTOs with 4+ fields, enums or string-literal unions accompanied by nullable/optional properties, methods with 3+ primitive parameters of the same type, or factory/constructor functions for domain concepts. **Diff signals:** new class/record/struct definitions for domain entities, enum or union definitions paired with companion optional fields, constructors or factory functions taking multiple `string`/`number`/`decimal` parameters for domain concepts (currency, amount, email, userId, etc.), methods with `if (status === ...)` branches, `throw` inside public methods guarded by state checks, validation logic appearing at multiple call sites for the same concept.

**Looks for:**
- **Primitive obsession:** Domain concepts (money, currency, email, ID types, percentages, dates-with-meaning) passed as raw `string`/`number`/`decimal` instead of value objects or branded types. Forces validation duplication at every call site and allows accidental mixing (e.g., passing a `userId` where an `orgId` was expected).
- **Data clumps:** 3+ values that always travel together (amount + currency + precision; lat + lng; street + city + zip; start + end + timezone) passed as separate parameters instead of a composed type. Each call site re-couples them; one missed update breaks the contract silently.
- **Enum-as-state with optional companions:** An enum or union representing lifecycle state accompanied by nullable properties that are only valid in certain states (`status: 'pending' | 'completed'` + `completedAt?: Date` + `failureReason?: string`). Symptom: you can construct an object in a state that shouldn't exist (`status: 'pending'` with `completedAt` set). Fix: discriminated union of state-specific types (TS), sealed hierarchy (C# records / abstract class), enum with data (Rust).
- **One class implementing several classes:** Methods with `if`/`switch` chains checking "which state am I in?" — each branch is a hidden type. The class exposes public methods that throw on invalid states instead of making invalid calls impossible by construction. Splitting into state-specific types eliminates the branches and the throws.
- **Public methods that throw on state:** `execute()` exists on the type but throws if the object isn't in the right state. Prefer making the method only available on the type that represents the valid state — the call becomes unrepresentable in the wrong state, not just rejected at runtime.
- **Validation scattered outside the type:** Validation logic for a domain concept (email format, amount > 0, currency code in allowlist) lives in callers, controllers, or service methods rather than in the type itself. The type should be impossible to construct in an invalid state — push validation into the constructor/factory and return a parsed result, not a raw value.
- **Stringly-typed identifiers:** All ID types are `string`, allowing a `userId` to be passed where an `orderId` was expected without compiler complaint. Use branded/nominal types (`UserId & { __brand: 'UserId' }` in TS, newtypes in Rust, strongly-typed IDs in C#).

**Key question:** "Could someone construct an instance of this type that represents an impossible business state, or call a method on it that's invalid for the current state? If yes, can the type itself prevent that?"

**Severity guidance:** Enum-as-state with nullable companions is **high** (extensibility killer — every new state multiplies the validity matrix). Public methods that throw on state are **high** when the throw is reachable from a valid construction path. One-class-many-states with throwing methods is **high**. Primitive obsession on a domain concept used in 3+ places is **medium-high**. Data clumps in 2+ signatures are **medium**. Scattered validation is **medium**. Stringly-typed identifiers in a domain with multiple ID types is **medium-high**.

**Context needed:** Diff + domain model / related types (Tier 1), or diff + call sites showing duplication or state-checking patterns (Tier 2+).

---

## Spec Fidelity

**Focus:** Does the code deliver what the spec or acceptance criteria specified?

**Deploy when:** Always for code reviews with a linked spec, ticket, or acceptance criteria document. Skipped if no spec context is available.

**Looks for:**
- AC items not addressed by the diff (note: multiple PRs may address one ticket — only flag if the diff actively contradicts the AC)
- Behavior that differs from what the spec describes
- Edge cases mentioned in AC but not handled
- Spec says X, code does Y

**Context needed:** Spec/AC + diff (all tiers)

---

## Spec Specificity

**Focus:** Plan-mode review — is the plan executable as-written? Are decisions resolved? Are constraints clear? This is a quality check on the *plan itself*, not on code.

**Deploy when:** Plan mode only. Triggered automatically when `entry_mode = plan`.

**Looks for:**
- **Unresolved decisions:** "or", "possibly", "might", "TBD", "we could…" — each is an unresolved ambiguity. The plan should name a chosen path.
- **Untestable success criteria:** "feels intuitive", "is fast enough" — surface as verification gaps. Either tighten with measurable criteria or acknowledge as deferred.
- **Missing verification methods:** Each acceptance criterion needs a stated way to verify (test, measurement, manual check).
- **Missing constraint architecture:** Musts, must-nots, preferences, escalation triggers should be named. Their absence encodes implicit constraints that future contributors will misremember.
- **Two-Agent Test failure:** If two different agents would produce meaningfully different output from this plan, it's under-specified.
- **Independent Observer Test failure:** If verifying the output requires asking the spec author a question, the plan is under-specified.
- **Decomposition not along natural seams:** Work packages that share state, or that need to be done in a specific order without that order being named.
- **WPs that fail one-sentence-gate:** A work package whose verification gate cannot be described in one sentence is too big.

**Severity guidance:** Unresolved decisions on critical-path items are **blocker**. Untestable success criteria for the primary feature behavior are **high**. Missing verification methods are **high**. Two-Agent / Observer Test failures are **high**. Decomposition issues are **medium-high**.

**Context needed:** The plan/spec text + (Tier 2+) the codebase if grounding is needed.

---

## Data Integrity

**Focus:** Schema changes, migration safety, soft-delete patterns, referential integrity, transaction safety.

**Deploy when:** Any database changes — tables, migrations, queries, ORM models. **Diff signals:** migration files, schema definition files, ORM model changes, raw SQL strings, `CREATE`/`ALTER`/`DROP` statements, query builder calls that modify data.

**Looks for:**
- Missing soft-delete or audit columns on new tables where the convention requires them
- Missing foreign key relationships or referential integrity constraints
- `DROP` or destructive `DELETE`/`UPDATE` without safeguards (transactions, dry-run gates, backup steps)
- Schema changes that would break existing queries, views, or API consumers without a migration path
- Data-modifying operations outside transaction boundaries
- Missing index on columns used in high-frequency `WHERE`/`JOIN` conditions

**Context needed:** Diff + database conventions (Tier 1), or diff + related schema objects (Tier 2+)

---

## Performance

**Focus:** Query efficiency, N+1 patterns, unnecessary allocations, render cost, algorithmic complexity.

**Deploy when:** Large data set operations, query changes, API endpoints under load, hot-path logic. **Diff signals:** new or modified queries over large collections, loop structures with nested I/O calls, unbounded list loading, missing pagination, hot-path render logic in Svelte components or equivalent.

**Looks for:**
- Queries without appropriate filters on large tables or collections
- N+1 query patterns (loop issuing one DB/network call per iteration)
- Missing indexes on columns used in `WHERE`/`JOIN`
- Loading full records when only a subset of fields is needed (over-fetching)
- Unnecessary allocations or cloning in hot paths (especially relevant in Rust)
- Unbounded result sets returned to the client without pagination
- Event loop blocking: synchronous I/O (`readFileSync`, `execSync`), CPU-heavy computation without worker offload, large `JSON.parse`/`JSON.stringify` on the main thread
- Svelte reactivity over-triggering: `$effect` that triggers on every render cycle, `$derived` with expensive computation not memoized, reactive dependencies on object references that change identity without value change
- Missing AbortController on fetch/async operations that should be cancellable (component unmount, route change, user cancellation)
- Unbounded `Promise.all` without batching — risk of exhausting connections, file descriptors, or memory
- Rust-specific: `.clone()` in hot loops, `collect()` followed by re-iteration (process iterators lazily), blocking calls (`std::fs`, `std::net`) in async runtime

**Context needed:** Diff + query plans if available (Tier 2+)

---

## Async & Concurrency

**Focus:** Promise handling, async/await correctness, race conditions, resource cleanup, concurrent operation safety.

**Deploy when:** Any async code changes. **Diff signals:** `async`/`await` keywords, `Promise` construction, `.then()`/`.catch()` chains, `setTimeout`/`setInterval`, `AbortController`, event emitter patterns, worker threads, `Mutex`/`RwLock`/`Arc` in Rust, `tokio::spawn`, channel operations (`mpsc`, `oneshot`).

**Looks for:**
- **Floating promises:** Async calls without `await` or explicit void annotation. Fire-and-forget hides errors and creates unpredictable timing.
- **Missing error handling on promise chains:** `.then()` without `.catch()`, or `await` without try/catch in contexts where the error should be handled locally.
- **No-floating-promises violations:** Promises returned but not awaited in non-void contexts, especially in Express/Hono middleware or Svelte reactive blocks.
- **Race conditions in shared state:** Multiple async operations reading/writing the same state without coordination. Common in Svelte stores updated from multiple reactive sources.
- **Missing AbortController:** Long-running async operations (fetch, database queries, file I/O) without cancellation support. Especially important in Svelte component lifecycle (`onDestroy` should abort in-flight requests).
- **Async disposal failures:** Resources acquired in async setup not released on error paths (database connections, file handles, WebSocket connections). Check that `finally` blocks or `using` declarations cover cleanup.
- **`return await` in try/catch:** Missing `return await` inside try/catch loses the ability to catch rejections from the returned promise — the catch block won't fire.
- **Blocking the event loop:** Synchronous operations (CPU-heavy computation, `fs.readFileSync`, large JSON parsing) on the main thread in Node.js/Deno. Move to worker threads or async alternatives.
- **Unbounded `Promise.all`:** Large arrays passed to `Promise.all` without batching — can exhaust memory, file descriptors, or connection pools.
- **Rust async pitfalls:** Holding a `MutexGuard` across `.await` points (deadlock risk), blocking in async context (`std::thread::sleep` instead of `tokio::time::sleep`), missing `Send` bounds on futures passed to `tokio::spawn`.

**Severity guidance:** Floating promises in error-sensitive paths are **high**. Race conditions in shared state are **high**. Missing AbortController in component lifecycle is **medium-high**. Blocking event loop is **high** in server code, **medium** in CLI tools. Unbounded Promise.all is **medium-high**. Rust MutexGuard across await is **blocker**.

**Context needed:** Diff + async flow (Tier 1), or diff + full async call chain (Tier 2+)

---

## API Contract

**Focus:** Backwards compatibility, versioning, response shape, error handling. The HTTP/REST surface, not the internal service class shape (that's Service Architecture).

**Deploy when:** Any endpoint additions or modifications. **Diff signals:** route handler changes, HTTP method/path changes, response DTO modifications, status code changes, OpenAPI/Swagger spec changes, middleware changes.

**Looks for:**
- Breaking changes to existing endpoint signatures (path, method, required fields)
- Missing or inconsistent error response shapes
- Internal implementation details or raw persistence entities returned instead of response DTOs
- Missing input validation on new parameters
- Undocumented behavior changes that affect callers
- Inconsistent HTTP status code usage

**Context needed:** Diff + existing endpoint definitions (Tier 2+)

---

## Integration

**Focus:** Cross-project dependencies, message contracts, shared type consistency, bridge behavior.

**Deploy when:** Changes spanning multiple packages or services. **Diff signals:** files in 2+ package/service trees touched in the same diff, shared DTO or schema type modifications, event/message format changes, changes to a published interface consumed by other packages.

**Looks for:**
- Contract changes in one package without corresponding updates in consuming packages
- API or event schema changes without handler updates
- Message format changes without producer/consumer version alignment
- Shared type definitions duplicated instead of referenced from a single source
- Semantic drift between layers (e.g., suppression or validation logic defined differently in two services)

**Context needed:** Diffs across all affected packages/services (Tier 2+)

---

## TypeScript Patterns

**Focus:** Type safety, `any`/`unknown` misuse, generic overuse, type assertion vs type guard discipline.

**Deploy when:** Any TypeScript file changes. **Diff signals:** `.ts`/`.tsx`/`.svelte` files, `any` keyword, `as` casts, `!` non-null assertions, generic type parameters, `unknown`, utility types (`Partial`, `Record`, `Pick`, etc.).

**Looks for:**
- **`any` abuse:** `any` used where a specific type, `unknown`, or a narrow generic would work. `any` disables the type checker for the entire value — each usage needs explicit justification.
- **Unsafe `as` casts:** Type assertions that paper over a type mismatch rather than narrowing with a guard. Prefer `satisfies`, type predicates (`x is T`), or Zod/schema validation at trust boundaries.
- **Non-null assertion (`!`) without justification:** `obj!.property` at a site where `obj` could genuinely be null/undefined. Use optional chaining + explicit fallback or a guard.
- **Generic overuse:** Overly parameterized types that add complexity without enabling reuse. If every caller passes the same concrete type, the generic is noise.
- **Missing `satisfies` at construction:** Object literals assigned to wide types lose narrowing; `satisfies` preserves narrowing while enforcing the constraint.
- **`unknown` without narrowing before use:** Treating `unknown` as `any` in practice by immediately asserting. Narrow with type guards or schema parsing.
- **Enums vs union types:** `const enum` and `enum` produce runtime artifacts; prefer `as const` object maps or string-literal union types for most cases.
- **Missing return type annotations on exported functions:** Exported API surface should have explicit return types to prevent accidental widening.
- **Async discipline:** Promises in non-void positions without `await` (no-floating-promises), incorrect conditional checks on promises instead of their resolved values (no-misused-promises), missing `return await` in try/catch blocks
- **ESM/CJS interop issues:** `require()` in ESM modules, missing `.js` extensions in relative imports (required by Node.js ESM), `moduleResolution` mismatch between tsconfig and runtime
- **Switch exhaustiveness:** Switch on discriminated unions without exhaustive case handling — use `never` type in default to catch missing cases at compile time

**Severity guidance:** `any` in a shared utility or exported type is **high** (type unsafety propagates to callers). Unsafe `as` cast at a trust boundary is **high**. Non-null assertion in hot or error-path code is **medium-high**. Generic overuse is **medium**. Missing return type on exported function is **medium**. Enum vs union preference is **low** unless the project convention document specifies otherwise.

**Context needed:** Diff + tsconfig (Tier 1), or diff + type declaration files and call sites (Tier 2+)

---

## Dependency Management

**Focus:** `package.json` hygiene, unused or redundant dependencies, version pinning strategy, known security advisories.

**Deploy when:** Any `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, or equivalent manifest changes. **Diff signals:** `dependencies`/`devDependencies`/`[dependencies]` blocks modified, new `import` statements for packages not previously used, version range changes, lockfile changes.

**Looks for:**
- **New dependency without justification:** A new package added where an existing dependency or stdlib equivalent would suffice. Every new dependency is a supply-chain risk and a maintenance burden.
- **Dev dependency in production dependencies:** Test frameworks, type stubs, build tools, and linters belong in `devDependencies`/`[dev-dependencies]`. Misplacement bloats production bundles/images.
- **Unpinned version ranges on security-sensitive packages:** `^` or `~` ranges on auth, crypto, or parsing libraries allow silent upgrades to versions with breaking changes or CVEs. Pin these.
- **Known security advisories:** New or updated packages with open CVEs in `npm audit`, `cargo audit`, or equivalent. Any critical/high advisory is a blocker.
- **Duplicate functionality:** Two packages in the manifest that solve the same problem (e.g., two date libraries, two HTTP clients). Consolidate.
- **Unused dependencies:** Packages listed in the manifest with no import sites in the codebase.
- **Cargo.lock committed inconsistently:** Rust binaries should commit `Cargo.lock`; libraries should not. Misalignment from convention is a **medium** flag.

**Severity guidance:** Known critical/high CVE on a new dependency is **blocker**. Dev dep in prod deps is **high** (bundle/image bloat + attack surface). Unjustified new dep with a stdlib equivalent is **medium**. Unpinned security-sensitive package is **medium-high**. Unused dep is **low**. Duplicate functionality is **medium**.

**Context needed:** Diff + manifest files + (Tier 2+) audit report output and import sites.

---

## Pragmatist

**Focus:** Is the change surface area proportional to the feature scope? Is there a simpler path?

**Deploy when:** Diff touches 4+ files, introduces new abstractions or data model fields, or adds infrastructure (new event types, new shared utilities, new linking mechanisms). Also useful when the diff feels "heavy" relative to what the feature delivers. **Diff signals:** new abstractions, new DTO or schema fields, new migrations, "forced" edits in many files.

**Looks for:**
- New abstractions that could be avoided by leveraging existing patterns
- Server-side or persistence changes that could be avoided with a client-side-only approach
- Files changed as a downstream consequence of an architectural choice rather than a direct requirement of the feature
- "Forced changes" — edits that wouldn't be needed under an alternative approach (count them explicitly)
- Novel patterns introduced when a conventional pattern exists for the same problem

**Key question:** "If an experienced developer in this codebase were asked to do this in the fewest files possible while following existing conventions, what would they do differently?"

**Severity guidance:** Pragmatist findings are typically **medium** — they represent implementation cost, not correctness bugs. Escalate to **high** only when the extra complexity introduces new defect surface area (e.g., multiple guard sites that must all be updated consistently, where missing one is a bug).

**Skip when:** Privacy, security hardening, or correctness work that is inherently surface-area-heavy. Pragmatist on such changes is mostly noise — the extra surface IS the feature.

**Context needed:** Diff + codebase conventions + existing patterns for similar features (Tier 2+)

---

## Fresh Eyes

**Focus:** Minimal context review — does this code make sense on its own terms?

**Deploy when:** Opt-in, or after standard waves converge as a final sanity check.

**Key difference:** This reviewer gets NO domain conventions, NO project-specific patterns, NO prior wave findings. It sees only the code and any specs/plans referenced.

**Looks for:**
- Code that doesn't do what its own names/comments claim
- Logic flows that are confusing to a competent developer seeing this for the first time
- Assumptions that aren't documented
- Tests that don't actually test what they claim to

**Context needed:** Code only. No conventions. No prior findings.

---

## Composition Guidance

**Default cap:** 2-7 archetypes per wave. Tier 1 reviews bias toward 2-4; Tier 3 reviews can go to 7.

**Composition heuristics for the cartographer:**

1. **Security is the mandatory floor — always include, no exceptions.** Even on diffs where no security signals fire (e.g., pure config, documentation-only changes), Security runs; if it has nothing to flag it returns "No issues found." This is the "always-on security" pattern validated by Cloudflare's production multi-agent code review system and supported by multi-reviewer convergence research (SWR-Bench Sep 2025). It cannot be dropped to free a slot for narrow archetypes — pick narrow archetypes from the remaining 1-6 slots.
2. **Spec Fidelity** is mandatory unless no spec or AC is available. **Spec Specificity** replaces it for plan-mode reviews.
3. **Code Quality** is the default broad reviewer — include unless 2+ narrow archetypes (Service Architecture, Data Integrity, TypeScript Patterns, etc.) cover the same surface, in which case skip to avoid duplication.
4. **TypeScript Patterns** is mandatory when any `.ts`, `.tsx`, or `.svelte` file is in the diff. Even one changed TypeScript file → include.
5. **Service Architecture** is mandatory for service decompositions or new service/application-layer files.
6. **Domain Modeling** fires when the diff introduces or modifies domain entity/model types: new class/record/struct definitions for business concepts, DTOs with 4+ fields, enums or unions paired with nullable companion properties, factory/constructor functions taking multiple primitive parameters for the same concept, or methods that branch on state via `if`/`switch`. Strong overlap with TypeScript Patterns on TS code — when both fire, Domain Modeling owns the structural-shape concerns (impossibility of invalid states, value objects, discriminated unions for state) and TypeScript Patterns owns the idiomatic-usage concerns (`any`/`as`/generic discipline). Drop Code Quality when both Domain Modeling and TypeScript Patterns are selected on the same surface.
7. **Data Integrity** is mandatory when migration files, schema definitions, or raw query changes are in the diff.
8. **Dependency Management** is mandatory when any package manifest or lockfile is in the diff.
9. **Integration** fires when the diff touches files in 2+ package or service trees simultaneously.
10. **Async & Concurrency** is mandatory when async patterns are prominent in the diff — `async`/`await`, Promise chains, event emitters, worker threads, or Rust async runtime usage. Even a few async changes in error-sensitive paths warrant inclusion.
11. **Pragmatist** is skipped on privacy, security hardening, or correctness work (those are inherently surface-area-heavy).
12. **Fresh Eyes** is opt-in — usually deployed as a final-pass sanity check, not as part of the initial wave.

**Anti-patterns:**
- **Don't over-compose.** A 2-reviewer composition on a simple fix is correct (Security + Spec Fidelity is the smallest legal composition). Deploying 7 reviewers on a config change wastes tokens.
- **Don't under-compose on risky changes.** A schema migration affecting access-controlled data needs Data Integrity AND Spec Fidelity, even if it's only a few lines (Security is automatic).
- **Don't pick narrow + broad for the same surface.** If you're picking TypeScript Patterns and Service Architecture for a new service file, drop Code Quality — they cover its surface more sharply.
- **Don't drop Security to make room.** Security is the floor. If you need a slot, drop a narrow archetype, not Security.
