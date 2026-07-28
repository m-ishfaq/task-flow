/**
 * GUARDRAIL 11 — a service method that mutates state must emit a domain event.
 *
 * PLAN.md §2.1: "A service method that mutates state without emitting a typed
 * event from packages/events fails lint."
 *
 * Why a custom rule rather than a selector: this is a "contains X but NOT Y"
 * question about a function body, and `no-restricted-syntax` can only ask
 * "contains X". Three guardrails in this repo were once silently dead because
 * they matched nothing, so a rule that cannot express what it claims to check is
 * worse than no rule — it reads as coverage.
 *
 * The defect class it targets: audit entries, notifications, search indexing,
 * and automation triggers all consume the event stream. A mutation without an
 * event still renders correctly on screen, so nothing fails and no test goes
 * red. The audit gap is found during an incident, the stale index when someone
 * cannot find their own work.
 *
 * DELIBERATE LIMITS — the rule is honest about what it cannot see:
 *
 *   - It cannot tell whether the event is the RIGHT one. That needs the payload
 *     and therefore type information. `RecordingEventBus` in @taskflow/events is
 *     how a slice asserts which events it emitted.
 *   - It matches syntax, so it depends on the mandated shape: mutations go
 *     through a handle named `tx`/`db`/`trx` from `withOrgScope`. That naming is
 *     load-bearing, which is a real cost — the alternative is flagging every
 *     `map.delete(key)` in a service and training people to reach for a disable.
 *   - It is scoped to service files. Repositories and migrations mutate without
 *     emitting by design; a rule that fires there would be noise.
 */

/** Drizzle mutation builders. Reads (`select`, `query`) are absent on purpose. */
const MUTATING_METHODS = new Set(['insert', 'update', 'delete']);

/** Receivers that denote a database handle. See the naming caveat above. */
const DB_RECEIVERS = new Set(['tx', 'db', 'trx', 'transaction']);

/** Anything that publishes a domain event or writes one to the outbox. */
const EMIT_METHODS = new Set(['emit', 'emitAll', 'publish', 'append']);

/** @type {import('eslint').Rule.RuleModule} */
export const requireDomainEvent = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a domain event alongside any state mutation in a service method.',
    },
    schema: [],
    messages: {
      missing:
        'This mutates state but the enclosing service method emits no domain event. Audit, notifications, search indexing, and automation all read the event stream, and a silent mutation breaks all four without failing anything. Emit a typed event from @taskflow/events. See PLAN.md §2.1 guardrail 11.',
    },
  },

  create(context) {
    /**
     * The unit of analysis is the OUTERMOST function in a file — the exported
     * service method. Everything nested inside it is transparent.
     *
     * That matters because the mandated shape puts the mutation and the emit in
     * different functions:
     *
     *   export async function moveCard(...) {
     *     await withOrgScope(orgId, async (tx) => { await tx.update(...) });
     *     await events.emit(cardMoved, ...);
     *   }
     *
     * Treating the arrow as its own scope would report every correctly written
     * service in the codebase, which is the fastest way to get a guardrail
     * switched off.
     */
    let depth = 0;
    /** @type {{ node: import('estree').Node, mutations: import('estree').Node[], emits: number } | null} */
    let scope = null;

    function enter(node) {
      if (depth === 0) {
        scope = { node, mutations: [], emits: 0 };
      }
      depth += 1;
    }

    function exit() {
      depth -= 1;
      if (depth !== 0 || !scope) return;

      if (scope.mutations.length > 0 && scope.emits === 0) {
        // Report the mutation rather than the function header, so a method with
        // several writes points at a statement the reader can act on.
        context.report({ node: scope.mutations[0], messageId: 'missing' });
      }
      scope = null;
    }

    return {
      FunctionDeclaration: enter,
      'FunctionDeclaration:exit': exit,
      FunctionExpression: enter,
      'FunctionExpression:exit': exit,
      ArrowFunctionExpression: enter,
      'ArrowFunctionExpression:exit': exit,

      CallExpression(node) {
        if (!scope) return;
        if (node.callee.type !== 'MemberExpression') return;

        const property = node.callee.property;
        if (property.type !== 'Identifier') return;

        if (EMIT_METHODS.has(property.name)) {
          scope.emits += 1;
          return;
        }

        if (!MUTATING_METHODS.has(property.name)) return;

        const receiver = node.callee.object;
        const receiverName =
          receiver.type === 'Identifier'
            ? receiver.name
            : receiver.type === 'MemberExpression' && receiver.property.type === 'Identifier'
              ? receiver.property.name
              : undefined;

        if (receiverName !== undefined && DB_RECEIVERS.has(receiverName)) {
          scope.mutations.push(node);
        }
      },
    };
  },
};

export default requireDomainEvent;
