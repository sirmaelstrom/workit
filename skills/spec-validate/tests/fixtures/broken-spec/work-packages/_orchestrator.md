# Orchestrator — broken negative-control fixture

Minimal but valid coordination layer. Deliberate errors in this fixture: the
missing required field in wp-missing-field.md, the empty `projects` array in
meta.json, and (as a consequence of the empty declaration) the inventory row
below targeting a project that is not declared in meta.projects.

## Wave Plan

Wave 1: [WP-01: Missing field]

## Gate Commands

Wave 1: npm test

## Package Inventory

| Package | Wave | Project | Spec | Model |
|---------|------|---------|------|-------|
| WP-01: Missing field | 1 | example-service | [wp-missing-field.md](wp-missing-field.md) | - |

## Spec-Level Constraints

### Musts

1. This orchestrator exists only to isolate the missing-field error below.
