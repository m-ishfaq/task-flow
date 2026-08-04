import type { DomainEvent } from '@taskflow/events';
import type { AdminConnection } from '@taskflow/db/testing';
import type { StorageProvider } from '@taskflow/contracts';
import type { SeedModule } from './registry.js';
import type { Profile } from './profiles.js';
import type { Rng } from './rng.js';

/**
 * What a seed module is handed.
 *
 * The connection underneath is the MIGRATOR, obtained through
 * `@taskflow/db/testing` — the one sanctioned door to a non-application
 * connection (guardrail 2 bans importing `pg` here, and that ban is doing its
 * job: this package could not open its own pool if it tried).
 *
 * That role is `NOBYPASSRLS` like every other, which is the point worth
 * repeating before writing a module: **`orgScope` is not a convenience.** A
 * write issued without it is filtered out by the row-level policy and inserts
 * nothing, and because an INSERT that writes zero rows raises no error, the run
 * finishes green with a table that stayed empty.
 */
export interface SeedContext {
  readonly db: SeedDb;
  readonly rng: Rng;
  readonly profile: Profile;
  /**
   * The instant the run started, used for every derived timestamp.
   *
   * One value read once rather than `new Date()` per row: a card created "12
   * days ago" and its comments must agree about when now is, and a long run
   * would otherwise spread a single board's rows across the minutes it took to
   * write them.
   */
  readonly now: Date;
  /**
   * `--chaos` (off by default). Lets a module deliberately create the
   * pathological states normal generation never produces on its own — two
   * cards with equal ranks in one list, so the `InvalidRankError` -> rebalance
   * -> `list.rebalanced` path (CLAUDE.md) can be exercised on demand instead of
   * waiting for a real collision.
   */
  readonly chaos: boolean;
  /**
   * Object storage, or null when attachments cannot be seeded for real —
   * `STORAGE_*` unset, or the profile does not ask for them. `platform.attachments`
   * treats null as "skip", never as "fake it": CLAUDE.md is explicit that an
   * attachment row with no object behind it is a lie, not a smaller version of
   * the feature.
   */
  readonly storage: StorageProvider | null;
  log(message: string): void;
  /**
   * The output of a module this one declared in `requires`.
   *
   * Throws rather than returning undefined for an undeclared module, because the
   * alternative is a module that reads `undefined`, writes a few hundred rows
   * with null parents, and fails on a foreign key far from the mistake.
   */
  use<Out>(module: SeedModule<Out>): Out;
  /** Buffers a domain event. Written to the outbox by `platform.audit`. */
  emit(event: DomainEvent): void;
  /** Every buffered event, in emission order. Read by `platform.audit`. */
  bufferedEvents(): readonly DomainEvent[];
  /** Runs `fn` with `app.org_id` set, restoring the previous scope afterwards. */
  orgScope<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * A column in an insert, optionally with a cast: `'description::jsonb'`.
 *
 * The cast is not decoration. Two of them are load-bearing:
 *
 *   `::jsonb`  — node-postgres renders a JS ARRAY as a Postgres array literal,
 *                not as JSON, so `custom_field_defs.options` (a jsonb array of
 *                choices) would arrive as `{a,b}` and fail `jsonb_typeof(...) =
 *                'array'`. Values for these columns are stringified here.
 *   `::uuid[]` — `cards.assignee_ids` is a real Postgres array, and without the
 *                cast an empty one is ambiguous to the driver.
 */
export type SeedColumn = string;

export interface SeedDb {
  /** Escape hatch for the few statements that are not bulk inserts. */
  query(text: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /**
   * A chunked multi-row INSERT.
   *
   * Rows are sent in batches rather than one statement per row because the
   * difference at this volume is minutes: a demo run writes on the order of
   * fifteen thousand rows, and a round trip each would dominate everything else
   * the seeder does.
   */
  insert(
    table: string,
    columns: readonly SeedColumn[],
    rows: readonly (readonly unknown[])[],
  ): Promise<number>;
}

/** Postgres refuses a statement carrying more than this many parameters. */
const MAX_PARAMETERS = 65_535;

/** Batch ceiling independent of width, so one statement stays readable in a log. */
const MAX_ROWS_PER_STATEMENT = 500;

interface ParsedColumn {
  readonly name: string;
  readonly cast: string | undefined;
}

function parseColumn(column: SeedColumn): ParsedColumn {
  const index = column.indexOf('::');
  if (index === -1) return { name: column, cast: undefined };
  return { name: column.slice(0, index), cast: column.slice(index + 2) };
}

/** jsonb values are stringified here; see the note on `SeedColumn`. */
function prepare(value: unknown, cast: string | undefined): unknown {
  if (cast === undefined) return value;
  if (!cast.startsWith('json')) return value;
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function createSeedDb(connection: AdminConnection): SeedDb {
  return {
    query: async (text, values) => {
      const result = await connection.query(text, values);
      return result.rows;
    },

    insert: async (table, columns, rows) => {
      if (rows.length === 0) return 0;

      const parsed = columns.map(parseColumn);
      const columnList = parsed.map((column) => `"${column.name}"`).join(', ');
      const perStatement = Math.max(
        1,
        Math.min(MAX_ROWS_PER_STATEMENT, Math.floor((MAX_PARAMETERS - 1) / parsed.length)),
      );

      let written = 0;

      for (let start = 0; start < rows.length; start += perStatement) {
        const batch = rows.slice(start, start + perStatement);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const row of batch) {
          if (row.length !== parsed.length) {
            throw new Error(
              `${table}: row has ${String(row.length)} values for ${String(parsed.length)} columns.`,
            );
          }

          const placeholders = row.map((value, index) => {
            const column = parsed[index];
            const cast = column?.cast;
            values.push(prepare(value, cast));
            const placeholder = `$${String(values.length)}`;
            return cast === undefined ? placeholder : `${placeholder}::${cast}`;
          });

          tuples.push(`(${placeholders.join(', ')})`);
        }

        const result = await connection.query(
          `INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(', ')}`,
          values,
        );

        /* A zero-row INSERT is the signature of a missing `orgScope`: RLS
           filtered the rows out and Postgres reported success. Left unchecked
           this is the single most confusing way for a seed run to "pass", so it
           is an error here rather than a surprise three modules later. */
        const inserted = result.rowCount ?? 0;
        if (inserted !== batch.length) {
          throw new Error(
            `${table}: inserted ${String(inserted)} of ${String(batch.length)} rows. ` +
              'Almost always a missing orgScope() — RLS drops rows whose org_id does not ' +
              'match app.org_id, and reports success.',
          );
        }

        written += inserted;
      }

      return written;
    },
  };
}

export interface CreateContextOptions {
  readonly connection: AdminConnection;
  readonly rng: Rng;
  readonly profile: Profile;
  readonly now: Date;
  readonly chaos: boolean;
  readonly storage: StorageProvider | null;
  readonly log: (message: string) => void;
}

/** The context plus the internals the runner needs to drive it. */
export interface SeedContextHandle {
  readonly ctx: SeedContext;
  /** An arrow-typed property, not method shorthand — `cli.ts` destructures
   * this alongside `ctx`, and method shorthand on an interface leaves
   * `@typescript-eslint/unbound-method` unable to tell the implementation
   * never reads `this` (which it does not; see below). */
  readonly record: (module: SeedModule, output: unknown) => void;
}

export function createSeedContext(options: CreateContextOptions): SeedContextHandle {
  const outputs = new Map<SeedModule, unknown>();
  const events: DomainEvent[] = [];
  const db = createSeedDb(options.connection);

  let currentOrg: string | null = null;

  const ctx: SeedContext = {
    db,
    rng: options.rng,
    profile: options.profile,
    now: options.now,
    chaos: options.chaos,
    storage: options.storage,
    log: options.log,

    use: <Out,>(module: SeedModule<Out>): Out => {
      if (!outputs.has(module)) {
        throw new Error(
          `Seed module "${module.name}" has not run. Add it to the \`requires\` list of the ` +
            'module asking for it — dependencies are resolved from that list, not from imports.',
        );
      }
      return outputs.get(module) as Out;
    },

    emit: (event) => {
      events.push(event);
    },

    bufferedEvents: () => events,

    orgScope: async (orgId, fn) => {
      const previous = currentOrg;
      await options.connection.setOrg(orgId);
      currentOrg = orgId;
      try {
        return await fn();
      } finally {
        await options.connection.setOrg(previous);
        currentOrg = previous;
      }
    },
  };

  return {
    ctx,
    record: (module, output) => {
      outputs.set(module, output);
    },
  };
}
