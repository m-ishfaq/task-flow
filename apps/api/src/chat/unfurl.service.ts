import { and, eq, inArray, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { ChannelId, MessageId, OrgId, RequestId, UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { getResolvedBranding } from '../platform-admin/branding-cache.js';
import { messageUnfurled } from './events.js';
import { extractUrls, fetchUnfurl } from './unfurl.js';
import { enforceOnChannel, loadChannel, orgOf, type ChatActor } from './shared.js';

/**
 * Link previews (Wave 3, ai/phase-5-chat.md §3.10, §7.6).
 *
 * ## Asynchronous, and that is the resolved §7.6 call
 *
 * The message is written and broadcast first. Only then does anything reach out
 * to a third-party server, and the preview arrives as a second, smaller event.
 * The alternative — fetch, then send — makes every message containing a link
 * wait on a host we do not control, so one slow site becomes a hanging send
 * button for whoever pasted it.
 *
 * ## Nothing here is called by the person who sent the message
 *
 * `unfurlMessage` runs detached from the request that created the message. That
 * is why it takes an explicit org, channel and actor rather than a `ChatActor`
 * built from a live principal: by the time it runs, the request is over. It
 * does no authorization of its own for the same reason — the authorization that
 * matters already happened, when `sendMessage` decided this person could post
 * here. Re-checking against a principal that no longer exists would be
 * theatre.
 *
 * The read path (`previewsFor`) is the opposite: it IS called by a request, and
 * it enforces `channel:read` like everything else that returns channel content.
 */

export interface MessagePreview {
  readonly messageId: string;
  readonly url: string;
  readonly status: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly siteName: string | null;
}

/** How many links in one message are previewed. The rest are left as text. */
const MAX_LINKS_PER_MESSAGE = 3;

export interface UnfurlContext {
  readonly orgId: OrgId;
  readonly channelId: ChannelId;
  readonly messageId: MessageId;
  readonly actorId: UserId;
  readonly requestId: RequestId;
}

/**
 * Fetches previews for every link in a message and records them.
 *
 * Returns rather than throws on every failure: this runs detached, so an
 * exception has nowhere to go but an unhandled rejection. A link that cannot be
 * previewed is recorded as `refused` or `failed` and the message is otherwise
 * untouched.
 */
export async function unfurlMessage(
  context: UnfurlContext,
  bodyText: string,
): Promise<{ readonly previewCount: number }> {
  const urls = extractUrls(bodyText, MAX_LINKS_PER_MESSAGE);
  if (urls.length === 0) return { previewCount: 0 };

  /* Fetched in parallel but bounded by MAX_LINKS_PER_MESSAGE, so one message
     cannot open an unbounded number of outbound connections. `allSettled`
     rather than `all`: one refused link must not discard the previews that
     succeeded. */
  const { productName } = await getResolvedBranding();
  const results = await Promise.allSettled(urls.map((url) => fetchUnfurl(url, productName)));

  const rows = results.map((result, index) => {
    const url = urls[index] ?? '';

    if (result.status === 'rejected') {
      return { url, status: 'failed' as const };
    }

    const outcome = result.value;
    if (!outcome.ok) {
      /* `refused` is TERMINAL and `failed` is not — the distinction is what
         stops a retry pass hammering a URL the SSRF control will never allow,
         and it is the only place an operator can see that someone is pasting
         links to internal addresses. */
      return {
        url,
        status: outcome.reason === 'refused' ? ('refused' as const) : ('failed' as const),
      };
    }

    return {
      url,
      status: 'ok' as const,
      title: outcome.preview.title,
      description: outcome.preview.description,
      imageUrl: outcome.preview.imageUrl,
      siteName: outcome.preview.siteName,
    };
  });

  const previewCount = rows.filter((row) => row.status === 'ok').length;

  await withOrgScope(context.orgId, async (tx) => {
    for (const row of rows) {
      await tx
        .insert(schema.messageUnfurls)
        .values({
          orgId: context.orgId,
          channelId: context.channelId,
          messageId: context.messageId,
          url: row.url,
          status: row.status,
          title: 'title' in row ? row.title : null,
          description: 'description' in row ? row.description : null,
          imageUrl: 'imageUrl' in row ? row.imageUrl : null,
          siteName: 'siteName' in row ? row.siteName : null,
        })
        /* The same message can be unfurled twice — a retry, an edit that kept
           the link. The primary key is (org, message, url), so this is an
           upsert rather than a duplicate-key failure. */
        .onConflictDoNothing();
    }

    await outboxWriter.append(tx, [
      createEvent(
        messageUnfurled,
        {
          messageId: context.messageId,
          channelId: context.channelId,
          previewCount,
        },
        {
          orgId: context.orgId,
          actorId: context.actorId,
          requestId: context.requestId,
        },
      ),
    ]);
  });

  return { previewCount };
}

/** Every preview for the named messages. `channel:read`. */
export async function previewsFor(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageIds: readonly MessageId[] },
): Promise<readonly MessagePreview[]> {
  if (input.messageIds.length === 0) return [];

  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const rows = await tx
      .select({
        messageId: schema.messageUnfurls.messageId,
        url: schema.messageUnfurls.url,
        status: schema.messageUnfurls.status,
        title: schema.messageUnfurls.title,
        description: schema.messageUnfurls.description,
        imageUrl: schema.messageUnfurls.imageUrl,
        siteName: schema.messageUnfurls.siteName,
      })
      .from(schema.messageUnfurls)
      .where(
        and(
          eq(schema.messageUnfurls.channelId, input.channelId),
          inArray(schema.messageUnfurls.messageId, [...input.messageIds]),
        ),
      );

    /* Only the ones that resolved. A `refused` or `failed` row exists so the
       fetcher knows not to try again; it is not something to render, and
       sending it would tell every reader which links the SSRF control
       rejected. */
    return rows.filter((row) => row.status === 'ok');
  });
}
