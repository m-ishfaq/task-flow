import { describe, expect, it } from 'vitest';
import {
  defineSeedModule,
  resolveModules,
  tablesInTeardownOrder,
  type SeedModule,
} from './registry.js';

/** A no-op module, for graph shape tests that never actually run `seed`. */
function stub(
  name: string,
  requires: readonly SeedModule[],
  tables: readonly string[],
): SeedModule {
  return defineSeedModule({ name, requires, tables, seed: () => Promise.resolve(undefined) });
}

describe('resolveModules', () => {
  it('runs a dependency before any module that requires it', () => {
    const users = stub('identity.users', [], ['identity.users']);
    const orgs = stub('tenancy.orgs', [users], ['identity.orgs']);
    const projects = stub('work.projects', [orgs], ['work.projects']);

    const ordered = resolveModules([projects]).map((m) => m.name);

    expect(ordered.indexOf('identity.users')).toBeLessThan(ordered.indexOf('tenancy.orgs'));
    expect(ordered.indexOf('tenancy.orgs')).toBeLessThan(ordered.indexOf('work.projects'));
  });

  it('runs a module reachable through two paths exactly once', () => {
    const users = stub('identity.users', [], ['identity.users']);
    const orgs = stub('tenancy.orgs', [users], ['identity.orgs']);
    const boards = stub('work.boards', [orgs], ['work.boards']);
    const cards = stub('work.cards', [boards], ['work.cards']);
    const tuples = stub('authz.tuples', [boards], ['authz.relationship_tuples']);
    const audit = stub('platform.audit', [cards, tuples], ['platform.outbox']);

    const ordered = resolveModules([audit]);
    const names = ordered.map((m) => m.name);

    expect(names.filter((name) => name === 'work.boards')).toHaveLength(1);
    expect(names.filter((name) => name === 'tenancy.orgs')).toHaveLength(1);
    expect(names[names.length - 1]).toBe('platform.audit');
  });

  it('two roots produce one merged, still-ordered graph', () => {
    const users = stub('identity.users', [], ['identity.users']);
    const orgs = stub('tenancy.orgs', [users], ['identity.orgs']);
    const other = stub('platform.attachments', [orgs], ['platform.attachments']);

    const ordered = resolveModules([orgs, other]).map((m) => m.name);
    expect(ordered).toEqual(['identity.users', 'tenancy.orgs', 'platform.attachments']);
  });

  it('throws on a circular dependency, naming the cycle', () => {
    // Built with a mutable array because `requires` is populated after both
    // modules exist — a real cycle cannot be expressed any other way in
    // TypeScript, since each module would need the other before it is defined.
    const requiresOfA: SeedModule[] = [];
    const a = defineSeedModule({
      name: 'a',
      requires: requiresOfA,
      tables: [],
      seed: () => Promise.resolve(undefined),
    });
    const b = defineSeedModule({
      name: 'b',
      requires: [a],
      tables: [],
      seed: () => Promise.resolve(undefined),
    });
    requiresOfA.push(b);

    expect(() => resolveModules([a])).toThrow(/circular/i);
  });

  it('throws when two modules share a name', () => {
    const a = stub('duplicate', [], []);
    const b = stub('duplicate', [], []);
    const root = stub('root', [a, b], []);

    expect(() => resolveModules([root])).toThrow(/duplicate/i);
  });

  it('is stable: resolving the same graph twice gives the same order', () => {
    const users = stub('identity.users', [], ['identity.users']);
    const orgs = stub('tenancy.orgs', [users], ['identity.orgs']);
    const projects = stub('work.projects', [orgs], ['work.projects']);
    const boards = stub('work.boards', [projects], ['work.boards']);

    const first = resolveModules([boards]).map((m) => m.name);
    const second = resolveModules([boards]).map((m) => m.name);
    expect(first).toEqual(second);
  });
});

describe('tablesInTeardownOrder', () => {
  it('reverses the run order', () => {
    const users = stub('identity.users', [], ['identity.users']);
    const orgs = stub('tenancy.orgs', [users], ['identity.orgs', 'identity.memberships']);
    const projects = stub('work.projects', [orgs], ['work.projects']);

    const ordered = resolveModules([projects]);
    const tables = tablesInTeardownOrder(ordered);

    expect(tables).toEqual([
      'work.projects',
      'identity.memberships',
      'identity.orgs',
      'identity.users',
    ]);
  });

  it('keeps only the LAST occurrence when two modules declare the same table', () => {
    const first = stub('first', [], ['shared.table', 'first.only']);
    const second = stub('second', [first], ['shared.table']);

    const tables = tablesInTeardownOrder(resolveModules([second]));

    // 'second' runs after 'first', so in teardown order it clears first —
    // and 'shared.table' must appear only once, at that later position.
    expect(tables).toEqual(['shared.table', 'first.only']);
  });

  it('produces an empty list for a graph with no tables', () => {
    const empty = stub('empty', [], []);
    expect(tablesInTeardownOrder(resolveModules([empty]))).toEqual([]);
  });
});
