# Prototype — UI Branch

A **UI prototype** is several radically different visual variations on a single route, switchable from a floating bar in the UI itself. The user toggles between variants, mixes ideas, and converges on a direction before any production code is written.

The point is **taste-driven design exploration**. AI can't see what it's building; humans have to sit in the loop. This skill gives the human the right interaction surface to give that feedback efficiently.

You're answering questions like:

- What should this dashboard feel like?
- Is this form better as a single page, a wizard, or an inline progressive disclosure?
- Where should the primary action live, and how prominent should it be?
- Does this data want a table, a list, or a card grid?

## Structure: Two Sub-Shapes

### Sub-shape A (preferred): Variants on an Existing Route

The page you're prototyping already exists in some form. Add a `?variant=` URL param. Render conditionally based on the param. The variants share real data, real headers, real surrounding context — only the in-page design changes.

This is the better shape because the variants are evaluated *in their actual context*. A dashboard variant that looks great on a blank page might fail on the real page with the real header, sidebar, and adjacent components.

### Sub-shape B (last resort): A Throwaway Route

If there's no existing route (the page doesn't exist yet, or you can't easily attach to an existing one), create a new throwaway route. Follow the project's routing conventions — don't invent new top-level structure. Name it so its temporariness is obvious: `/proto/<feature>` or `/__prototype__/<feature>`.

## Process

### 1. State the Question

At the top of the prototype (or in a sibling NOTES.md):

```
PROTOTYPE — wipe me when answered
Question: What should the new project-detail dashboard feel like?
Variants: card-grid | sidebar-summary | full-bleed-timeline
Route: /projects/[id]?variant=card-grid (or ?variant=sidebar-summary, etc.)
```

### 2. Generate 3 Structurally Different Variants

Target **3 variants. Cap at 5.** More than 5 and the comparison breaks down; the user can't hold them all in working memory.

The variants must be **structurally different**, not cosmetically different. Different layouts, different information hierarchies, different primary actions, different progressive disclosure strategies. If two variants only differ in color or font, they're the same variant.

Examples of *structural* difference for a project-detail page:
- Card grid of related items with the project summary as a header strip
- Two-column layout with a persistent sidebar summary and main-content scroll
- Full-bleed timeline with the project as a horizontal scrolling story

Examples of *cosmetic* difference (don't do this):
- Same layout, blue vs green primary buttons
- Same layout, sans-serif vs serif headers

### 3. Wire the Variants Together

In the route's main component, branch on the `variant` URL param. Default to the first variant if no param is present (so the page still renders).

```tsx
// pseudocode
const variant = searchParams.get('variant') ?? 'card-grid';
return match(variant)
  .with('card-grid', () => <CardGridVariant {...data} />)
  .with('sidebar-summary', () => <SidebarSummaryVariant {...data} />)
  .with('full-bleed-timeline', () => <TimelineVariant {...data} />)
  .otherwise(() => <CardGridVariant {...data} />);
```

### 4. Build the Floating Switcher

A small, visually-distinct floating bar in the bottom-center or bottom-right of the page. Requirements:

- Shows the current variant name
- Left/right arrow buttons to cycle through variants
- Keyboard arrow keys also cycle (`ArrowLeft` / `ArrowRight`)
- Visually obviously *not part of the real UI* — a bright background, "PROTO" label, or both. The user must never confuse it for production chrome.
- Hidden in production (gate on `NODE_ENV !== 'production'` or a clear feature flag)

The switcher updates the URL search param, which re-renders the variant. URL-driven means the user can share the link with someone else and they see the same variant.

### 5. Iterate With the Human in the Loop

Share the URL. The user clicks through variants, says what they like and don't like, and asks for mixes ("take the layout from A but use the card structure from B"). Generate a new variant for the mix. Discard variants the user has rejected.

This is the part AI alone cannot do. Taste belongs to the human. The skill's job is to make the iteration loop fast.

### 6. Promote the Winner, Delete the Rest

Once the user picks a direction:

- Promote the winning variant code into the real route (remove the `?variant=` branching)
- Delete the losing variant code, the switcher component, and the route branching
- Capture the decision in a durable place (commit message, ADR, or workshop `decisions.md`)
- If sub-shape B (throwaway route) was used, delete the route file

The end state should look as if the prototype never existed — except for the captured decision.

## What to Avoid

- **Cosmetic-only variants.** If the variants don't differ structurally, you're not prototyping, you're A/B-color-picking. Re-pick the variants.
- **More than 5 variants.** The user can't compare them; convergence stalls.
- **Switcher that looks like production chrome.** The user will commit it to main by mistake or take screenshots that look like real UI.
- **Forgetting to gate the switcher in production.** Even if you plan to delete it, gate it during the prototype phase. Accidents happen.
- **Shipping the switcher.** Even more important than gating it — when the variant is chosen, the switcher *and* the conditional branching must be deleted. The promoted code should be unconditional.
- **Skipping the decision capture.** Without recording *why* a variant won, the next person (or future-you) will second-guess the call.
