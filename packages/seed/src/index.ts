/**
 * @taskflow/seed — public surface.
 *
 * Consumed by `cli.ts` (this package's own entry point) and by tests that
 * want to exercise a module or the registry without going through argv. Not
 * meant to be imported by application code — this package takes the migrator
 * connection directly (`@taskflow/db/testing`), which is legitimate for a
 * seed and would be a guardrail violation anywhere else.
 */

export { createRng, type Rng } from './rng.js';
export {
  createSeedContext,
  createSeedDb,
  type SeedContext,
  type SeedDb,
  type SeedColumn,
  type CreateContextOptions,
  type SeedContextHandle,
} from './context.js';
export {
  defineSeedModule,
  resolveModules,
  tablesInTeardownOrder,
  type SeedModule,
} from './registry.js';
export {
  PROFILES,
  DEFAULT_PROFILE,
  findProfile,
  plannedCardCount,
  plannedMessageCount,
  plannedPageCount,
  LIST_NAMES,
  WIP_LIMITED_LIST,
  WIP_LIMIT,
  type Profile,
  type OrgPlan,
  type ProjectPlan,
  type BoardPlan,
  type ChannelPlan,
  type SpacePlan,
  type CardMix,
  type MessageMix,
  type PageMix,
  type PeopleMix,
} from './profiles.js';
export { reset, type ResetOptions, type ResetResult } from './reset.js';

export { usersModule, SEED_PASSWORD, SEED_EMAIL_DOMAIN } from './modules/identity.users.js';
export { orgsModule } from './modules/tenancy.orgs.js';
export { tuplesModule } from './modules/authz.tuples.js';
export { projectsModule } from './modules/work.projects.js';
export { boardsModule } from './modules/work.boards.js';
export { cardsModule } from './modules/work.cards.js';
export { viewsModule } from './modules/work.views.js';
export { channelsModule, type SeededChannel } from './modules/chat.channels.js';
export { messagesModule, type SeededMessageRef } from './modules/chat.messages.js';
export { spacesModule, type SeededSpace, type SeededPage } from './modules/docs.spaces.js';
export {
  contentModule,
  editDocument,
  collectTextNodes,
  pageLinkParagraph,
  nodeFor,
  type ContentOutput,
  type SeededPageContent,
} from './modules/docs.content.js';
export { commentsModule, type CommentOutput } from './modules/docs.comments.js';
export {
  peopleModule,
  type SeededPersonProfile,
  type SeededMembershipProfile,
  type PeopleOutput,
} from './modules/people.profiles.js';
export { suggestionsModule, type SuggestionOutput } from './modules/docs.suggestions.js';
export { templatesModule, type TemplateOutput } from './modules/docs.templates.js';
export { attachmentsModule } from './modules/platform.attachments.js';
export { auditModule } from './modules/platform.audit.js';
export { telephonyModule, type TelephonyOutput } from './modules/comms.telephony.js';
export { rtcModule } from './modules/rtc.calls.js';
export { notificationsModule } from './modules/platform.notifications.js';
export { pushSubscriptionsModule } from './modules/platform.push-subscriptions.js';
export { sessionsModule, type SessionsOutput } from './modules/identity.sessions.js';
