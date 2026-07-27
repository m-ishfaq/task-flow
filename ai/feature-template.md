# Feature template

The order to build a vertical slice. Following it means authorization and tenancy are decided
before there is code depending on getting them wrong.

## 1. Contract first

`packages/contracts/src/<module>/`

- Zod schemas for input and output, `.strict()`
- Branded ID types for anything identifying
- Domain event definitions

Shared by frontend and backend, so drift is a type error rather than a runtime surprise.

## 2. Permission

`packages/policy/src/actions.ts`

- Add the action to the `Action` union
- Add its row to the role matrix
- **Add the case to the authz matrix test** — it will fail until the matrix is filled in, which
  is the intended order

## 3. Migration

`packages/db/migrations/NNNN_<name>.up.sql` + `.down.sql`

- `org_id uuid NOT NULL` on any tenant table
- `tenantRlsPolicy(schema, table)` — `ENABLE` + `FORCE` + `USING` + `WITH CHECK`
- Indexes leading with `org_id`
- Grants, if creating a new schema
- Expand-migrate-contract: never rename or drop in the same migration that adds

Verify with `migrate:verify` (up → down → up) before moving on.

## 4. Schema types

`packages/db/src/schema/<module>.ts` — Drizzle table definitions, re-exported as `schema`.

## 5. Service

`apps/api/src/modules/<module>/service.ts`

- Every DB access inside `withOrgScope`
- Emit a domain event on every state change
- Business rules here, not in the router

## 6. Router

`apps/api/src/modules/<module>/router.ts`

- `.meta({ permission: 'module:action' })` — required, enforced by the type system
- Input/output schemas from `packages/contracts`
- Thin: parse, authorize, delegate, return

## 7. Tests

- Unit — pure logic (ranking, parsing, evaluation)
- Integration — every route: happy path, invalid input, **unauthorized per role**
- Confirm the tenancy fuzz test picked up the new endpoint

## 8. Frontend

`apps/web/src/features/<module>/`

- `api/` — TanStack Query hooks
- `components/`
- Optimistic mutation: `onMutate` snapshot + patch, `onError` rollback, `onSettled` invalidate
- Gate behind a feature flag if the module isn't launched

## 9. Before declaring done

- [ ] `pnpm verify` green
- [ ] [security-checklist.md](security-checklist.md) walked
- [ ] Flag registered if the module is unlaunched
- [ ] PLAN.md updated if a decision changed

## Anti-patterns

- Building all the APIs, then the frontend, then the tests. Slices ship whole.
- Adding `org_id` to WHERE clauses "to be safe" — it hides RLS misconfiguration. If RLS is
  wrong, you want to find out.
- Checking permissions in the router _and_ the service. One place — the router's declaration.
- Reaching for `withGlobalScope` because a query returned nothing. That is almost always RLS
  working correctly and the org context being wrong.
