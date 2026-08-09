/**
 * Transcript PII redaction (PLAN.md §8.5 — "PII in transcripts — Automatic
 * redaction pass (card numbers, national IDs) before storage";
 * ai/phase-7-voice.md §3.7).
 *
 * ## "Before storage" is the whole requirement
 *
 * The word `before` is load-bearing. A pass that ran after the INSERT and then
 * updated the row would leave a window — however short — where the unredacted
 * transcript exists at rest, in the WAL, in whatever replication or backup
 * touched that write, and in any log line that captured the statement. This
 * module is therefore a PURE function with no database access at all: it cannot
 * be called in the wrong order, because it has nothing to be out of order with.
 *
 * ## What this catches, and the honest limits
 *
 * Speech-to-text output is not structured text. A card number arrives as
 * "four one one one, one one one one..." as often as "4111111111111111", and no
 * regex finds the spoken form reliably. So this is a **reduction in exposure,
 * not a guarantee of none** — and it is worth saying plainly here, because the
 * failure mode of a redactor is that everyone downstream believes the output is
 * clean.
 *
 * What that means in practice: the controls that actually protect a transcript
 * are the ones around it — `recording:read` is Admin-and-Owner only, transcripts
 * live under RLS, and `REDACTION_PATHS` keeps them out of logs. This pass
 * removes the highest-value strings when they appear in a machine-readable form.
 */

/** A single redaction rule. Order matters — see `redactTranscript`. */
interface RedactionRule {
  readonly label: string;
  readonly pattern: RegExp;
  readonly placeholder: string;
  /** Extra check before replacing, for patterns that over-match on digits. */
  readonly confirm?: (match: string) => boolean;
}

/**
 * Luhn check, used to avoid redacting every 16-digit number as a card.
 *
 * Without it, an order number, a meeting ID, or a spoken sequence of digits gets
 * replaced, and a transcript full of `[redacted]` is one nobody trusts or reads
 * — which is its own way of losing the record.
 */
export function passesLuhn(digits: string): boolean {
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.length < 13 || clean.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = clean.length - 1; index >= 0; index -= 1) {
    let digit = clean.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: readonly RedactionRule[] = [
  {
    /* Payment card numbers, with or without the usual separators. Confirmed by
       Luhn so that a 16-digit reference number survives.
     *
     * The shape is `digit, then 12-18 more each preceded by AT MOST ONE
     * separator`. The obvious alternative — `(?:\d[ -]*?){13,19}` — is what
     * this was first written as, and it under-matches: with irregular grouping
     * ("4111 111 11 1111 111") the lazy inner quantifier settles on a 13-digit
     * match, Luhn then fails on those 13 digits, and a REAL card number passes
     * through unredacted. It looked right, and it passed a test written with
     * tidy four-digit groups. Keep the separator bounded at one. */
    label: 'card_number',
    pattern: /\d(?:[ -]?\d){12,18}/g,
    placeholder: '[redacted:card]',
    confirm: passesLuhn,
  },
  {
    /* US Social Security numbers. Separators required — a bare nine-digit run
       is far more often a phone number, an order id, or a zip+4 concatenation,
       and redacting all of them makes the transcript useless. */
    label: 'us_ssn',
    pattern: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g,
    placeholder: '[redacted:ssn]',
  },
  {
    /* UK National Insurance number: two letters, six digits, one suffix letter.
       The excluded prefixes (D, F, I, Q, U, V first; O second) are not issued,
       which keeps this off ordinary two-letter-plus-digits strings. */
    label: 'uk_nino',
    pattern: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi,
    placeholder: '[redacted:nino]',
  },
  {
    /* IBAN. Two letters, two check digits, then up to 30 alphanumerics. */
    label: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    placeholder: '[redacted:iban]',
  },
  {
    /* CVV spoken alongside a card. Only matched when explicitly labelled —
       three digits on their own are far too common to touch. */
    label: 'cvv',
    pattern: /\b(?:cvv|cvc|security code)\b[^0-9]{0,10}\d{3,4}\b/gi,
    placeholder: '[redacted:cvv]',
  },
  {
    label: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    placeholder: '[redacted:email]',
  },
];

export interface RedactionResult {
  readonly text: string;
  /** Which rules fired, and how often. Safe to log — it contains no matches. */
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Redacts a transcript. Pure — no I/O, no clock, no database.
 *
 * Rules run in the order declared, and card numbers run FIRST on purpose: a
 * card number contains digit runs that the SSN pattern would otherwise claim
 * part of, and once a placeholder is in place the later rules see
 * `[redacted:card]` rather than a partial number they could half-match and
 * leave the rest of exposed.
 */
export function redactTranscript(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let output = text;

  for (const rule of RULES) {
    let fired = 0;

    output = output.replace(rule.pattern, (match) => {
      if (rule.confirm !== undefined && !rule.confirm(match)) return match;
      fired += 1;
      return rule.placeholder;
    });

    if (fired > 0) counts[rule.label] = fired;
  }

  return { text: output, counts };
}
