import { describe, expect, it } from 'vitest';
import {
  defineSeedModule,
  resolveModules,
  tablesInTeardownOrder,
  type SeedModule,
} from './registry.js';
import { auditModule } from './modules/platform.audit.js';

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

/**
 * The REAL graph, not stubs.
 *
 * Everything above proves the resolver works on shapes invented for it. This
 * proves the shape the CLI actually seeds, which is the thing that breaks when
 * a module is added: `cli.ts` passes `auditModule` as its only root and reaches
 * every other module through `requires`, so a module whose dependency edge was
 * forgotten does not fail — it silently never runs, and its tables stay empty
 * while the run reports success.
 */
describe('the registered module graph', () => {
  const ordered = resolveModules([auditModule]);
  const names = ordered.map((module) => module.name);
  const tables = tablesInTeardownOrder(ordered);

  it('reaches every module from the audit root alone', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'identity.users',
        'tenancy.orgs',
        'work.projects',
        'work.boards',
        'work.cards',
        'work.views',
        'chat.channels',
        'chat.messages',
        'platform.attachments',
        'authz.tuples',
        'platform.audit',
      ]),
    );
  });

  it('runs chat.channels before chat.messages, and both before the audit drain', () => {
    // A message needs a channel to reference — the composite FK on
    // (org_id, channel_id) makes the reverse order a foreign key violation
    // rather than a subtle wrongness.
    expect(names.indexOf('chat.channels')).toBeLessThan(names.indexOf('chat.messages'));
    expect(names.indexOf('chat.messages')).toBeLessThan(names.indexOf('platform.audit'));
  });

  it('runs chat.messages before platform.attachments', () => {
    // Message attachments hang off `messageRefs`, which only exists once the
    // messages module has run.
    expect(names.indexOf('chat.messages')).toBeLessThan(names.indexOf('platform.attachments'));
  });

  it('runs platform.audit last, so it sees every buffered event', () => {
    expect(names[names.length - 1]).toBe('platform.audit');
  });

  it('reaches work.views, which nothing else depends on', () => {
    /* No module reads its output, so the only thing keeping it in the graph is
       the entry in `platform.audit`'s `requires`. Drop that and the module does
       not fail — it silently never runs, and `work.views` stays empty while the
       run reports success. */
    expect(names).toContain('work.views');
    expect(names.indexOf('work.boards')).toBeLessThan(names.indexOf('work.views'));
    expect(tables).toContain('work.views');
  });

  it('clears every chat child table before chat.channels', () => {
    /* Teardown is the run order reversed, derived rather than written — the
       hand-maintained DELETE list is the thing that rots. This asserts the
       derivation actually lands the chat tables children-first. */
    for (const table of [
      'chat.messages',
      'chat.message_reactions',
      'chat.pinned_messages',
      'chat.read_cursors',
      'chat.message_unfurls',
    ]) {
      expect(tables.indexOf(table), table).toBeGreaterThanOrEqual(0);
      expect(tables.indexOf(table), table).toBeLessThan(tables.indexOf('chat.channels'));
    }
  });

  it('lists authz.relationship_tuples exactly once despite two modules writing it', () => {
    // `chat.channels` writes channel membership there and `authz.tuples` writes
    // board grants. A table cleared twice is harmless; a table cleared at the
    // wrong position is not, and the de-duplication keeping the LAST occurrence
    // is what decides where.
    expect(tables.filter((table) => table === 'authz.relationship_tuples')).toHaveLength(1);
  });
});
