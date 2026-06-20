# Orchestrator — broken negative-control fixture

Minimal but valid coordination layer, so the ONLY work-package error in this
fixture is the deliberately missing required field in wp-missing-field.md.

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
