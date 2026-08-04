import type { SeedContext } from './context.js';

/**
 * The module graph.
 *
 * The whole extensibility argument of this package lives in this file. Adding
 * Chat in Phase 5 should be one new file plus one entry in `modules/index.ts`,
 * and nothing else — not a run-order list, not a teardown list, not a change to
 * anything that already works.
 *
 * Two decisions make that true:
 *
 *   1. `requires` holds MODULE OBJECTS, not names. A dependency is therefore a
 *      real import, checked by the compiler, and `ctx.use(mod)` returns that
 *      module's declared output type with no string keys and no casting. A
 *      module that reads output it never declared a dependency on is a type
 *      error, not a run-time `undefined` two hundred rows later.
 *
 *   2. Teardown order is the run order REVERSED, derived rather than written.
 *      The hand-maintained DELETE list is the thing that rots: a table added in
 *      one place and forgotten in the other leaves the reset silently partial,
 *      and the symptom is a foreign key violation on the NEXT run, pointing at
 *      the wrong module.
 */

export interface SeedModule<Out = unknown> {
  /** Dotted, schema-first — `work.cards`. Shown in the run log. */
  readonly name: string;
  /** Modules whose output this one reads. Order within the list is irrelevant. */
  readonly requires: readonly SeedModule[];
  /**
   * Tables this module writes, qualified: `work.cards`.
   *
   * Used only by the reset, and deliberately declared rather than inferred —
   * there is no way to observe which tables a module touched without running
   * it, and a reset that has to run the seeder first is not a reset.
   */
  readonly tables: readonly string[];
  seed(ctx: SeedContext): Promise<Out>;
}

/**
 * Defines a module, inferring `Out` from the `seed` function.
 *
 * A plain object literal would infer `Out` as whatever the function returns and
 * then widen `SeedModule<Out>` to `SeedModule<unknown>` at the first place it is
 * stored in a `readonly SeedModule[]`. Going through a generic function pins the
 * type to the value, which is what keeps `ctx.use()` honest.
 */
export function defineSeedModule<Out>(module: SeedModule<Out>): SeedModule<Out> {
  return module;
}

/**
 * Every module reachable from `roots`, in an order where dependencies run first.
 *
 * Callers register only what they want; dependencies are pulled in transitively,
 * so a profile asking for cards cannot accidentally run without boards.
 *
 * The traversal is depth-first and follows declaration order, which makes the
 * result stable: two runs of the same registry produce the same order, and the
 * seed's determinism depends on that as much as it depends on the RNG.
 */
export function resolveModules(roots: readonly SeedModule[]): readonly SeedModule[] {
  const ordered: SeedModule[] = [];
  const settled = new Set<SeedModule>();
  const visiting = new Set<SeedModule>();

  const visit = (module: SeedModule, trail: readonly string[]): void => {
    if (settled.has(module)) return;

    if (visiting.has(module)) {
      throw new Error(
        `Circular seed dependency: ${[...trail, module.name].join(' -> ')}. ` +
          'A cycle has no valid run order; split the shared rows into a third module.',
      );
    }

    visiting.add(module);
    for (const dependency of module.requires) {
      visit(dependency, [...trail, module.name]);
    }
    visiting.delete(module);

    settled.add(module);
    ordered.push(module);
  };

  for (const root of roots) visit(root, []);

  const names = new Set<string>();
  for (const module of ordered) {
    if (names.has(module.name)) {
      throw new Error(
        `Two seed modules are both named "${module.name}". Names appear in the run log and ` +
          'in the reset summary, so they have to be unique.',
      );
    }
    names.add(module.name);
  }

  return ordered;
}

/**
 * Tables to clear, children before parents.
 *
 * The reverse of the run order, de-duplicated keeping the LAST occurrence — a
 * table written by two modules must be cleared after the later one's other
 * tables, not before them.
 */
export function tablesInTeardownOrder(ordered: readonly SeedModule[]): readonly string[] {
  const seen = new Set<string>();
  const tables: string[] = [];

  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const module = ordered[i];
    if (!module) continue;
    // Within a module, later tables are the more dependent ones, so they clear
    // first — same rule as between modules.
    for (let j = module.tables.length - 1; j >= 0; j -= 1) {
      const table = module.tables[j];
      if (table === undefined || seen.has(table)) continue;
      seen.add(table);
      tables.push(table);
    }
  }

  return tables;
}
