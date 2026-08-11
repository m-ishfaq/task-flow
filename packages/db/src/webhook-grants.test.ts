import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, connectAsMigrator, type AdminConnection } from './testing/index.js';

/**
 * Migration 0049's grants, asserted against a real database.
 *
 * The 0036 lesson, applied to webhooks: `platform` carries ALTER DEFAULT
 * PRIVILEGES from 0001, so `taskflow_app` holds full CRUD on every table the
 * migrator creates there BEFORE any GRANT in 0049 runs. The migration's
 * REVOKEs on `webhook_deliveries` are what make "the application cannot
 * rewrite a delivery's outcome" a fact rather than an intention — and the
 * only way to know they took is to ask the database.
 *
 * The second half is the claim-only separation at the heart of the design:
 * `taskflow_webhook` decides WHICH deliveries are due and records their
 * outcomes, and must be unable to read what it is delivering (`payload`) or
 * learn anything about the endpoint (no grant on `platform.webhooks` at all).
 * That property is invisible in application code — nothing imports it — so it
 * needs a test, or the day someone adds a convenience grant is the day it
 * silently stops being true.
 */

let admin: AdminConnection;

/** `has_table_privilege` for one role/table/privilege, as a plain boolean. */
async function can(role: string, table: string, privilege: string): Promise<boolean> {
  const result = await admin.query(`SELECT has_table_privilege($1, $2, $3) AS allowed`, [
    role,
    table,
    privilege,
  ]);
  return result.rows[0]?.['allowed'] === true;
}

/** `has_column_privilege` — the shape the claim role's COLUMN-LEVEL grants take. */
async function canColumn(
  role: string,
  table: string,
  column: string,
  privilege: string,
): Promise<boolean> {
  const result = await admin.query(`SELECT has_column_privilege($1, $2, $3, $4) AS allowed`, [
    role,
    table,
    column,
    privilege,
  ]);
  return result.rows[0]?.['allowed'] === true;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
});

afterAll(async () => {
  await admin.end();
});

describe('taskflow_webhook — claim-only, by GRANT', () => {
  it('may claim due deliveries and mark their outcomes', async () => {
    /* The recording-ingest recipe: a conditional UPDATE on `attempts` needs
       SELECT on the claim columns and UPDATE on the outcome columns, and
       nothing more. */
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'id', 'SELECT')).toBe(true);
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'attempts', 'SELECT')).toBe(true);
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'attempts', 'UPDATE')).toBe(true);
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'status', 'UPDATE')).toBe(true);
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'next_attempt_at', 'UPDATE')).toBe(true);
  });

  it('cannot read the payload — the role that decides what to deliver cannot read what is being delivered', async () => {
    /* THE column-level exclusion. Without it, the role that claims rows
       across every tenant is also a cross-tenant reader of the card data the
       payloads carry. */
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'payload', 'SELECT')).toBe(false);
    expect(await canColumn('taskflow_webhook', 'platform.webhook_deliveries', 'event_name', 'SELECT')).toBe(false);
  });

  it('holds NOTHING on platform.webhooks — no URL, no signing key', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await can('taskflow_webhook', 'platform.webhooks', privilege),
        `taskflow_webhook must not hold ${privilege} on platform.webhooks`,
      ).toBe(false);
    }
  });

  it('cannot reach a tenant table', async () => {
    expect(await can('taskflow_webhook', 'work.cards', 'SELECT')).toBe(false);
  });
});

describe('taskflow_app — what 0049 grants, and what it takes back', () => {
  it('holds full CRUD on the endpoints themselves', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await can('taskflow_app', 'platform.webhooks', privilege)).toBe(true);
    }
  });

  it('can append a delivery but never rewrite or erase one', async () => {
    /* THE 0036 ASSERTION for this table. `ALTER DEFAULT PRIVILEGES` granted
       UPDATE and DELETE here before 0049's own GRANT ran; the explicit REVOKEs
       are what remove them. Delete those two lines from the migration and
       this test is what fails — nothing in the application would. */
    expect(await can('taskflow_app', 'platform.webhook_deliveries', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'platform.webhook_deliveries', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'platform.webhook_deliveries', 'UPDATE')).toBe(false);
    expect(await can('taskflow_app', 'platform.webhook_deliveries', 'DELETE')).toBe(false);
  });
});
