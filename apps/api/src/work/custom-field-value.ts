import { z } from 'zod';
import { errors, isValidId } from '@taskflow/contracts';

/**
 * Custom field values — validating jsonb against its definition (PLAN.md §3.1).
 *
 * The value column is `jsonb`, so the DATABASE cannot check it: a `number`
 * field will happily store the string `"tomorrow"`, and nothing notices until
 * a filter tries to compare it or a chart tries to sum it. The definition's
 * `type` is the only thing that says how a value should be read, which makes
 * this function the only place the two are ever brought together.
 *
 * It is deliberately strict rather than coercive. Accepting `"3"` for a number
 * field and storing `3` would be friendly, and would mean the value that comes
 * back differs from the one sent — which breaks optimistic UI, and makes the
 * Phase 8 filter compiler's job ambiguous because it can no longer assume the
 * stored shape.
 */

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'user',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export function isCustomFieldType(value: string): value is CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);
}

/** Options for a select field. Closed set, validated on the definition. */
export const CustomFieldOptions = z.array(z.string().trim().min(1).max(80)).min(1).max(100);

const MAX_TEXT = 2000;

/**
 * Checks a value against its field definition, returning the value to store.
 *
 * Returns rather than mutates so the caller writes exactly what was validated —
 * a validator that only says yes or no invites the caller to store the raw
 * input alongside it, and the two drift the first time normalization is added.
 */
export function validateFieldValue(
  field: { readonly type: string; readonly name: string; readonly options: unknown },
  value: unknown,
): unknown {
  // Null is always legal: it means "not set", and every field type is optional.
  // Requiring a value is a UI concern — enforcing it here would make a field
  // impossible to add to a project that already has cards.
  if (value === null) return null;

  const reject = (reason: string): never => {
    throw errors.validation({ [field.name]: reason });
  };

  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') return reject('Expected text.');
      if (value.length > MAX_TEXT) return reject(`Longer than ${String(MAX_TEXT)} characters.`);
      return value;
    }

    case 'number': {
      /* `Number.isFinite` rather than `typeof === 'number'`: NaN and Infinity
         are both numbers to JavaScript, both survive JSON.stringify as `null`,
         and both make a SUM in a Phase 11 chart produce nonsense. */
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return reject('Expected a finite number.');
      }
      return value;
    }

    case 'date': {
      if (typeof value !== 'string') return reject('Expected an ISO date string.');
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) return reject('Not a valid date.');
      // Normalized to an ISO instant so two clients sending the same day in
      // different formats compare equal in a filter.
      return new Date(parsed).toISOString();
    }

    case 'checkbox': {
      if (typeof value !== 'boolean') return reject('Expected true or false.');
      return value;
    }

    case 'select': {
      if (typeof value !== 'string') return reject('Expected one of the field options.');
      if (!optionsOf(field.options).includes(value)) return reject('Not one of the field options.');
      return value;
    }

    case 'multi_select': {
      if (!Array.isArray(value)) return reject('Expected a list of field options.');
      const allowed = optionsOf(field.options);
      const chosen = value.filter((entry): entry is string => typeof entry === 'string');
      if (chosen.length !== value.length) return reject('Expected a list of field options.');
      for (const entry of chosen) {
        if (!allowed.includes(entry)) return reject(`"${entry}" is not one of the field options.`);
      }
      // Deduplicated, so a card cannot hold the same option twice and make a
      // group-by count it twice.
      return [...new Set(chosen)];
    }

    case 'user': {
      /* Shape only. That this id names a MEMBER of the org is checked by the
         service, which has the transaction — the same split as `assignCard`,
         where the membership read is what RLS makes meaningful. */
      if (typeof value !== 'string' || !isValidId(value)) return reject('Expected a user id.');
      return value;
    }

    default:
      /* An unrecognized type reaches here only during a rolling deploy, from a
         definition written by a newer build. Refusing is right: storing a value
         nothing can interpret is worse than refusing to store it. */
      return reject('This field type is not supported by this version.');
  }
}

function optionsOf(options: unknown): readonly string[] {
  const parsed = CustomFieldOptions.safeParse(options);
  return parsed.success ? parsed.data : [];
}
