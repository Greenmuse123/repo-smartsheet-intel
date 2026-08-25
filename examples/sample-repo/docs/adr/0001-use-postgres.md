# ADR-0001: Use PostgreSQL for order storage

Status: Accepted

## Context

Orders must survive restarts and support simple reporting queries.

## Decision

We will use PostgreSQL via the `pg` driver rather than the in-memory array used in the prototype.

## Consequences

Requires a database in CI and a migration step at deploy time.
