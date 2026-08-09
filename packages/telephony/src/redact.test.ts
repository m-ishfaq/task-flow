import { describe, expect, it } from 'vitest';
import { passesLuhn, redactTranscript } from './redact.js';

describe('passesLuhn', () => {
  it('accepts real test card numbers', () => {
    expect(passesLuhn('4111111111111111')).toBe(true); // Visa test
    expect(passesLuhn('5500005555555559')).toBe(true); // Mastercard test
    expect(passesLuhn('4111 1111 1111 1111')).toBe(true);
  });

  it('rejects a number that merely looks like one', () => {
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(passesLuhn('1234567890123456')).toBe(false);
  });

  it('rejects lengths outside the card range', () => {
    expect(passesLuhn('411111111111')).toBe(false);
    expect(passesLuhn('41111111111111111111')).toBe(false);
  });
});

describe('redactTranscript', () => {
  it('redacts a spoken-out card number in digit form', () => {
    const result = redactTranscript('my card is 4111111111111111 expiring soon');
    expect(result.text).not.toContain('4111111111111111');
    expect(result.text).toContain('[redacted:card]');
    expect(result.counts['card_number']).toBe(1);
  });

  it('redacts a card number written with separators', () => {
    expect(redactTranscript('4111 1111 1111 1111').text).toBe('[redacted:card]');
    expect(redactTranscript('5500-0055-5555-5559').text).toBe('[redacted:card]');
  });

  it('redacts a card number grouped IRREGULARLY, not just in neat fours', () => {
    /* The case that caught the first version of the pattern. A transcript is
       machine-generated text, so digits arrive grouped however the speaker
       paused — not in the tidy 4-4-4-4 a hand-written test reaches for. The
       original `(?:\d[ -]*?){13,19}` settled on a 13-digit match here, Luhn
       failed on those 13 digits, and the real card went through in the clear. */
    const result = redactTranscript('card 4111 111 11 1111 111 ok');
    expect(result.text).toContain('[redacted:card]');
    expect(result.text.replace(/[^0-9]/g, '')).toBe('');
  });

  it('leaves a 16-digit number that is NOT a card alone', () => {
    /* Without the Luhn confirmation every order number and meeting id becomes
       [redacted:card], and a transcript full of placeholders is one nobody
       reads — which loses the record just as effectively as deleting it. */
    const result = redactTranscript('your order number is 1234567890123456');
    expect(result.text).toContain('1234567890123456');
    expect(result.counts['card_number']).toBeUndefined();
  });

  it('redacts a US SSN with separators', () => {
    expect(redactTranscript('ssn 123-45-6789').text).toContain('[redacted:ssn]');
    expect(redactTranscript('ssn 123 45 6789').text).toContain('[redacted:ssn]');
  });

  it('does not redact a bare nine-digit run as an SSN', () => {
    // Far more often a phone number or reference than an SSN.
    expect(redactTranscript('reference 123456789').text).toContain('123456789');
  });

  it('redacts a UK National Insurance number', () => {
    expect(redactTranscript('NI is AB123456C').text).toContain('[redacted:nino]');
    expect(redactTranscript('NI is AB 12 34 56 C').text).toContain('[redacted:nino]');
  });

  it('redacts an IBAN', () => {
    expect(redactTranscript('GB33BUKB20201555555555').text).toContain('[redacted:iban]');
  });

  it('redacts a labelled CVV but not three bare digits', () => {
    expect(redactTranscript('cvv 123').text).toContain('[redacted:cvv]');
    expect(redactTranscript('there were 123 of them').text).toContain('123');
  });

  it('redacts email addresses', () => {
    expect(redactTranscript('reach me at a.person@example.com').text).toContain('[redacted:email]');
  });

  it('leaves ordinary conversation untouched', () => {
    const text = 'Thanks for calling, I will send the quote over this afternoon.';
    const result = redactTranscript(text);
    expect(result.text).toBe(text);
    expect(Object.keys(result.counts)).toHaveLength(0);
  });

  it('runs card redaction before SSN so a card is not half-matched', () => {
    /* `4111 11 1111 1111` is a valid Visa test number (4111111111111111) AND
       contains `111 11 1111`, which the SSN pattern matches. If SSN ran first it
       would consume that slice and leave `4111` and `1111` in the clear — a
       PARTIAL redaction, which reads as success in a diff and in the counts. */
    const result = redactTranscript('card 4111 111 11 1111 111 ok');

    expect(result.counts['card_number']).toBe(1);
    expect(result.counts['us_ssn']).toBeUndefined();
    // No run of the original card digits survives anywhere in the output.
    expect(result.text.replace(/[^0-9]/g, '')).toBe('');
  });

  it('reports counts without echoing what it matched', () => {
    /* The counts are logged; the matches must never be. A result that carried
       the matched strings would put the PII straight back into the log line
       this pass exists to keep it out of. */
    const result = redactTranscript('4111111111111111 and 123-45-6789');
    expect(JSON.stringify(result.counts)).not.toContain('4111');
    expect(JSON.stringify(result.counts)).not.toContain('6789');
  });

  it('is pure — the same input always gives the same output', () => {
    const text = 'card 4111111111111111';
    expect(redactTranscript(text).text).toBe(redactTranscript(text).text);
  });
});
