import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BoardIdSchema,
  CardIdSchema,
  OrgIdSchema,
  UserIdSchema,
  isValidId,
  unsafeAsId,
  type CardId,
  type OrgId,
  type UserId,
} from './ids.js';

/**
 * Branded ids are guardrail 1 (PLAN.md §2.1). The type-level assertions here
 * matter as much as the runtime ones: the whole value of branding is that
 * mixing id types fails to COMPILE, and a refactor that accidentally widened
 * these back to `string` would leave every runtime test passing.
 */

describe('branded id types', () => {
  it('does not allow one id type where another is expected', () => {
    const orgId = unsafeAsId<'OrgId'>('11111111-1111-7111-8111-111111111111');
    const userId = unsafeAsId<'UserId'>('22222222-2222-7222-8222-222222222222');

    expectTypeOf(orgId).toEqualTypeOf<OrgId>();
    expectTypeOf(userId).toEqualTypeOf<UserId>();
    expectTypeOf(orgId).not.toEqualTypeOf<UserId>();

    // A branded id is still usable as a string.
    expectTypeOf(orgId).toExtend<string>();
    // A bare string is NOT usable as a branded id — the property being bought.
    expectTypeOf<string>().not.toExtend<OrgId>();
  });

  it('brands are erased at runtime', () => {
    const raw = '11111111-1111-7111-8111-111111111111';
    const orgId = unsafeAsId<'OrgId'>(raw);
    expect(orgId).toBe(raw);
    expect(typeof orgId).toBe('string');
    expect(JSON.stringify({ orgId })).toBe(`{"orgId":"${raw}"}`);
  });
});

describe('id schemas', () => {
  it('accepts UUIDv7, which is what the system actually issues', () => {
    // §7.1 specifies UUIDv7. Some Zod versions reject v7 from `.uuid()` because
    // the spec predates it, so the schema uses an explicit pattern instead. This
    // test exists to catch a regression back to `.uuid()`.
    const v7 = '018f4d1e-7c3a-7b2e-8f1a-2c9d3e4f5a6b';
    expect(OrgIdSchema.parse(v7)).toBe(v7);
  });

  it('accepts other UUID versions', () => {
    const v4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(CardIdSchema.parse(v4)).toBe(v4);
  });

  it('normalizes case so equality comparisons are reliable', () => {
    const upper = '018F4D1E-7C3A-7B2E-8F1A-2C9D3E4F5A6B';
    expect(BoardIdSchema.parse(upper)).toBe(upper.toLowerCase());
  });

  it.each([
    ['empty', ''],
    ['not a uuid', 'not-a-uuid'],
    ['too short', '018f4d1e-7c3a-7b2e-8f1a'],
    ['sequential integer', '1'],
    ['sql injection attempt', "1' OR '1'='1"],
    ['nil uuid (version 0)', '00000000-0000-0000-0000-000000000000'],
    ['bad variant nibble', '018f4d1e-7c3a-7b2e-1f1a-2c9d3e4f5a6b'],
  ])('rejects %s', (_label, value) => {
    expect(() => UserIdSchema.parse(value)).toThrow();
    expect(isValidId(value)).toBe(false);
  });

  it('produces a branded type from parsing', () => {
    const parsed = CardIdSchema.parse('018f4d1e-7c3a-7b2e-8f1a-2c9d3e4f5a6b');
    expectTypeOf(parsed).toEqualTypeOf<CardId>();
  });
});
