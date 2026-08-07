import { z } from 'zod';

/**
 * Branded identifier types — guardrail 1 (PLAN.md §2.1).
 *
 * Every entity id is a distinct type, so the compiler rejects passing a UserId
 * where a ChannelId belongs. That class of mistake is invisible in review when
 * everything is `string`, trivially produced by AI-generated code, and shows up
 * as an authorization bug rather than a crash — the caller looks up the wrong
 * object and gets someone else's data.
 *
 * Brands exist only in the type system. At runtime these are plain strings with
 * no wrapper and no cost.
 *
 * Construction is deliberately narrow. Ids enter the system through a PARSER at
 * a trust boundary (HTTP input, database row, environment) which validates the
 * format, or through `unsafeAs*` at a seam where validation already happened.
 * There is no general-purpose cast.
 */

declare const brand: unique symbol;

/** Attaches a compile-time-only tag to a primitive. */
type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * The branded string produced for tag `B` — `Id<'OrgId'>` is exactly `OrgId`.
 *
 * Exported so that generic code (an id generator, a repository base class) can
 * NAME the result type instead of inferring it. `Brand` itself stays private:
 * naming a type is not the same as being able to mint one, and every mint should
 * still go through a parser or an `unsafe*` call that reads as such.
 */
export type Id<B extends string> = Brand<string, B>;

/* -------------------------------------------------------------------------- *
 * Identifier types
 * -------------------------------------------------------------------------- */

export type OrgId = Brand<string, 'OrgId'>;
export type UserId = Brand<string, 'UserId'>;
export type MembershipId = Brand<string, 'MembershipId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type SessionId = Brand<string, 'SessionId'>;

export type ProjectId = Brand<string, 'ProjectId'>;
export type BoardId = Brand<string, 'BoardId'>;
export type ListId = Brand<string, 'ListId'>;
export type CardId = Brand<string, 'CardId'>;
export type LabelId = Brand<string, 'LabelId'>;
export type StatusId = Brand<string, 'StatusId'>;
export type SprintId = Brand<string, 'SprintId'>;
export type ChecklistId = Brand<string, 'ChecklistId'>;
export type ChecklistItemId = Brand<string, 'ChecklistItemId'>;
export type CustomFieldId = Brand<string, 'CustomFieldId'>;
export type ViewId = Brand<string, 'ViewId'>;

export type ChannelId = Brand<string, 'ChannelId'>;
export type MessageId = Brand<string, 'MessageId'>;

export type SpaceId = Brand<string, 'SpaceId'>;
export type PageId = Brand<string, 'PageId'>;

export type CommentId = Brand<string, 'CommentId'>;
export type SuggestionId = Brand<string, 'SuggestionId'>;
export type PageTemplateId = Brand<string, 'PageTemplateId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type ActivityId = Brand<string, 'ActivityId'>;
export type NotificationId = Brand<string, 'NotificationId'>;

/** Correlates a client mutation with its socket echo (PLAN.md §9). */
export type MutationId = Brand<string, 'MutationId'>;

/** Correlates logs, error envelopes, and audit entries (PLAN.md §14). */
export type RequestId = Brand<string, 'RequestId'>;

/* -------------------------------------------------------------------------- *
 * Parsing
 * -------------------------------------------------------------------------- */

/**
 * UUID pattern, accepting versions 1-8.
 *
 * Deliberately NOT `z.string().uuid()`: ids are UUIDv7 (§7.1), and some Zod
 * versions reject v7 as "not a valid UUID" because the spec predates it. A
 * validator that rejects the format the system actually issues is worse than
 * no validator, because the failure appears at the boundary of working code.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Zod schema for a branded id. Validates shape, then brands. */
function idSchema<B extends string>(_name: B) {
  return z
    .string()
    .regex(UUID_PATTERN, 'must be a UUID')
    .transform((value) => value.toLowerCase() as Brand<string, B>);
}

export const OrgIdSchema = idSchema('OrgId');
export const UserIdSchema = idSchema('UserId');
export const MembershipIdSchema = idSchema('MembershipId');
export const TeamIdSchema = idSchema('TeamId');
export const SessionIdSchema = idSchema('SessionId');

export const ProjectIdSchema = idSchema('ProjectId');
export const BoardIdSchema = idSchema('BoardId');
export const ListIdSchema = idSchema('ListId');
export const CardIdSchema = idSchema('CardId');
export const LabelIdSchema = idSchema('LabelId');
export const StatusIdSchema = idSchema('StatusId');
export const SprintIdSchema = idSchema('SprintId');
export const ChecklistIdSchema = idSchema('ChecklistId');
export const ChecklistItemIdSchema = idSchema('ChecklistItemId');
export const CustomFieldIdSchema = idSchema('CustomFieldId');
export const ViewIdSchema = idSchema('ViewId');

export const ChannelIdSchema = idSchema('ChannelId');
export const MessageIdSchema = idSchema('MessageId');

export const SpaceIdSchema = idSchema('SpaceId');
export const PageIdSchema = idSchema('PageId');

export const CommentIdSchema = idSchema('CommentId');
export const SuggestionIdSchema = idSchema('SuggestionId');
export const PageTemplateIdSchema = idSchema('PageTemplateId');
export const AttachmentIdSchema = idSchema('AttachmentId');
export const ActivityIdSchema = idSchema('ActivityId');
export const NotificationIdSchema = idSchema('NotificationId');

/**
 * Validates the shape of an id WITHOUT branding it.
 *
 * For wire formats — event envelopes, outbox rows, webhook bodies — where the
 * value is a UUID but the brand belongs to whoever consumes it, not to the
 * transport. Also avoids a real friction: a schema whose inferred output is
 * branded cannot have its type emitted by `tsc --declaration`, because the brand
 * symbol is intentionally not exported. `z.infer` of this one is just `string`.
 */
export const UuidSchema = z
  .string()
  .regex(UUID_PATTERN, 'must be a UUID')
  .transform((value) => value.toLowerCase());

/** True when a string is a syntactically valid identifier. */
export function isValidId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/* -------------------------------------------------------------------------- *
 * Unchecked construction
 * -------------------------------------------------------------------------- */

/**
 * Brands a string WITHOUT validating it.
 *
 * Legitimate only where the value is already known-good and re-validating would
 * be pure cost: rows read from our own database, and test fixtures. Every other
 * caller should parse.
 *
 * Named for what it is. A short, comfortable name here would get reached for by
 * default, and the whole point of guardrail 1 is that the unsafe path should
 * look unsafe at the call site.
 */
export function unsafeAsId<B extends string>(value: string): Brand<string, B> {
  return value as Brand<string, B>;
}

/**
 * Brands a database row's id column.
 *
 * A separate name from `unsafeAsId` so that grepping for trust-boundary bypasses
 * distinguishes "came from our database" (fine) from "came from somewhere else"
 * (needs a look).
 */
export function fromDatabase<B extends string>(value: string): Brand<string, B> {
  return value as Brand<string, B>;
}
