# Security checklist

Run through this before merging anything that touches data, auth, or an external boundary.
Derived from PLAN.md §8. Ordered by how often each item is actually the thing that was missed.

## Every change

- [ ] Does every DB read/write go through `withOrgScope`? No bare `pg` or Drizzle import?
- [ ] Does every new table have `org_id`, `ENABLE` + **`FORCE`** RLS, and a policy using
      `NULLIF(current_setting('app.org_id', true), '')::uuid` — with **both** `USING` and
      `WITH CHECK`?
- [ ] Does every new route declare a permission? (It won't compile otherwise — confirm you
      didn't work around it.)
- [ ] Is every input parsed by a `.strict()` Zod schema?
- [ ] Does every state mutation emit a domain event?
- [ ] Are new secrets in the env schema and `.env.example` — with a placeholder, never a value?

## Authorization

- [ ] Is the decision made by `can()`, not by an inline role check?
- [ ] Is the authz matrix test updated for the new action?
- [ ] Does the tenancy fuzz test cover the new endpoint? (It auto-enrolls from the router
      manifest — verify it actually picked it up.)
- [ ] For a guest-visible surface: are results intersected with their explicit grants?

## Data exposure

- [ ] Does the response include only fields the caller may see — no over-fetching then filtering
      in the UI?
- [ ] Are IDs UUIDv7 rather than sequential?
- [ ] Are error messages free of internal detail (table names, IDs, stack traces)?
- [ ] Are new sensitive fields added to `REDACTION_PATHS` in `@taskflow/observability`?

## Authentication (Phase 1+)

- [ ] Are tokens verified before _any_ use of their claims?
- [ ] Does this operation need step-up re-authentication? (role change, member removal, token
      creation, phone purchase, recording export, data export, workspace deletion)
- [ ] Is the refresh path rotating and detecting reuse?
- [ ] Are timing-safe comparisons used for secrets?

## External boundaries

- [ ] Are inbound webhooks signature-verified **before** the body is parsed or trusted?
- [ ] Is there replay protection (nonce + window)?
- [ ] Are outbound URLs validated against SSRF — private ranges blocked, redirects not followed?
- [ ] For uploads: MIME + size pinned in the presigned signature, magic bytes verified on
      confirm, AV scanned before the object is downloadable?

## Telephony (Phase 7)

- [ ] Is the org spend cap checked before the call/message is placed?
- [ ] Is the destination on the geo allowlist?
- [ ] Is recording consent recorded, and the jurisdiction announcement enforced?
- [ ] Is the suppression list checked before every send?

## Before merging to a human-review surface

`packages/policy` · `packages/db` · `packages/security` · `apps/api/src/identity` · webhook
verification · file handling · telephony spend:

- [ ] Read every line yourself — not a skim.
- [ ] Second adversarial AI pass in a **fresh context**, prompted as an attacker looking for a
      bypass. A "does this look right?" pass does not count.
- [ ] Property-based tests where the input space is large (token lifecycle, policy evaluation).

## What this checklist cannot do

It cannot catch a flaw in a design you got wrong from the start, and it cannot substitute for
the external review of auth and policy planned before real user data (PLAN.md §2.3). Treat a
clean checklist as necessary, not sufficient.
