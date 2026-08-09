-- 0039 — a member's work phone number, so click-to-call has something to dial
-- (PLAN.md §3.4: "click-to-call from any card/contact/chat thread").
--
-- ## Why membership_profiles and not profiles
--
-- `people.profiles` is keyed on user_id alone — it is the person's GLOBAL
-- profile, shared across every org they belong to. A phone number there would
-- be disclosed to every one of those orgs at once, including ones a contractor
-- joined for a week. `people.membership_profiles` is keyed on (org_id,
-- user_id) and carries the tenant-isolation policy 0031 established, so a
-- number set for one employer is invisible to another.
--
-- That is the same reasoning `job_title` and `department` already sit here for:
-- these are facts about someone's role IN AN ORG, not about the person.
--
-- ## Stored in plaintext, unlike comms counterparty numbers
--
-- `comms.calls.counterparty_ciphertext` is encrypted with a per-org data key
-- and blind-indexed, because those are numbers belonging to members of the
-- PUBLIC who never consented to be in this system — the org holds them as a
-- side effect of doing business.
--
-- This column is different in kind: it is a colleague's work contact detail,
-- entered by them, for the express purpose of being shown to colleagues in a
-- directory. Encrypting it would defeat the directory (every listing becomes a
-- per-row decrypt) while protecting a value that is, by design, displayed to
-- every member of the org. RLS is the control that fits the actual threat —
-- cross-tenant disclosure — and it already applies to this table.
--
-- The CHECK mirrors PhoneNumberSchema at the boundary rather than trusting it:
-- E.164 is a leading '+' followed by 1-15 digits with no leading zero. A
-- malformed value here would reach the geo allowlist, match no prefix, and be
-- denied for the wrong reason — a confusing refusal rather than a clear one.

ALTER TABLE people.membership_profiles
  ADD COLUMN work_phone text;

ALTER TABLE people.membership_profiles
  ADD CONSTRAINT membership_profiles_work_phone_e164
    CHECK (work_phone IS NULL OR work_phone ~ '^\+[1-9][0-9]{1,14}$');

COMMENT ON COLUMN people.membership_profiles.work_phone IS
  'E.164 work number for click-to-call, scoped to this org. Plaintext by design: a directory value shown to colleagues, protected by RLS rather than encryption — unlike comms counterparty numbers, which belong to the public.';
