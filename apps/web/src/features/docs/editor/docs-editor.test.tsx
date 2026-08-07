import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type * as Y from 'yjs';
import { createQueryClient } from '../../../lib/query.js';
import { useSession } from '../../../lib/session.js';
import { ToastProvider } from '../../../components/toast.js';

/**
 * The collaborative editor's wiring (ai/phase-6-docs.md §3.2, Wave 2).
 *
 * The handshake contract is what this test pins — NOT sync behaviour, which
 * needs a real gateway and is deliberately left to the end-to-end smoke test
 * (the codebase's own standing lesson: a green vitest run is not the same
 * claim as "this works when you click it"). `@hocuspocus/provider` is
 * replaced with a fake class that records its constructor options and its
 * `destroy()`, so the assertions are:
 *
 *   - the provider is constructed with the same-origin `/collab` URL
 *     carrying the org id as a query value, and the `page:{id}` document
 *     name (the exact strings `apps/collab/src/auth.ts` enforces);
 *   - the editor mounts and binds the Yjs fragment the server compacts —
 *     `field: 'content'` is observable because the Collaboration extension
 *     materializes that fragment on the shared Y.Doc;
 *   - unmounting destroys the provider (a second page opened after a first
 *     must not leak a live connection).
 *
 * The fake awareness is the minimal surface `CollaborationCaret`'s plugin
 * (`awareness.states`, `on/off('update')`, `setLocalStateField`) and
 * `@tiptap/y-tiptap`'s cursor plugin (`getLocalState`, `getStates`) touch.
 */

interface FakeProviderOptions {
  readonly url: string;
  readonly name: string;
  readonly document: Y.Doc;
  readonly token: () => Promise<string>;
  readonly onStatus: (args: { status: 'connecting' | 'connected' | 'disconnected' }) => void;
  readonly onSynced: (args: { state: boolean }) => void;
}

const hoisted = vi.hoisted(() => {
  const instances: FakeHocuspocusProvider[] = [];

  class FakeHocuspocusProvider {
    readonly options: FakeProviderOptions;
    destroyed = false;
    constructor(options: FakeProviderOptions) {
      this.options = options;
      instances.push(this);
    }

    get document(): Y.Doc {
      return this.options.document;
    }

    get awareness() {
      const localClientId = 123;
      const states = new Map<number, Record<string, unknown>>();
      const listeners = new Set<() => void>();
      return {
        clientID: localClientId,
        states,
        getLocalState: () => states.get(localClientId) ?? null,
        getStates: () => states,
        setLocalStateField: (field: string, value: unknown) => {
          const current = states.get(localClientId) ?? {};
          current[field] = value;
          states.set(localClientId, current);
        },
        on: (name: string, handler: () => void) => {
          if (name === 'update') listeners.add(handler);
        },
        off: (name: string, handler: () => void) => {
          if (name === 'update') listeners.delete(handler);
        },
      };
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  return { FakeHocuspocusProvider, instances };
});

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: hoisted.FakeHocuspocusProvider,
}));

/* The editor resolves `@mention` candidates and the caret's display name
   through `useMembers`, which otherwise hits the real tRPC client. */
vi.mock('../../org/use-members.js', () => ({
  useMembers: () => ({
    people: [
      { userId: 'user-ada', email: 'ada@taskflow.test', displayName: 'Ada' },
      { userId: 'user-grace', email: 'grace@taskflow.test', displayName: 'Grace' },
    ],
    personOf: (userId: string) => ({
      userId,
      label: userId === 'user-ada' ? 'Ada' : 'Grace',
      email: 'ada@taskflow.test',
      named: true,
    }),
    peopleOf: (userIds: readonly string[]) =>
      userIds.map((userId) => ({
        userId,
        label: userId === 'user-ada' ? 'Ada' : 'Grace',
        email: 'ada@taskflow.test',
        named: true,
      })),
    isPending: false,
  }),
}));

const { DocsEditor } = await import('./docs-editor.js');

const ORG_ID = '019faee8-0000-7000-8000-0000000000f0';
const PAGE_ID = '019faee8-0000-7000-8000-000000000002';

function renderEditor() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <DocsEditor orgId={ORG_ID as never} pageId={PAGE_ID as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  hoisted.instances.length = 0;

  useSession.setState({
    status: 'authenticated',
    accessToken: 'token',
    expiresAt: Date.now() + 600_000,
    sessionId: 'session',
    userId: 'user-ada',
    orgId: ORG_ID as never,
    email: 'ada@taskflow.test',
  });
});

afterEach(() => {
  /* The provider's document is a real Y.Doc destroyed on unmount; reset the
     store so the next test starts anonymous rather than reusing this one's
     identity. Wrapped in `act` because this hook runs BEFORE setup.ts's
     `cleanup()` (vitest runs afterEach hooks in reverse registration order),
     so the editor is still mounted here — an unwrapped `setState` fires
     every `useSession` subscriber (DocsEditorReady's two selectors) into a
     render outside act, which is the "not wrapped in act" noise this file
     was showing. `act` absorbs those notifications. */
  act(() => {
    useSession.setState({
      status: 'anonymous',
      accessToken: null,
      expiresAt: null,
      sessionId: null,
      userId: null,
      orgId: null,
      email: null,
    });
  });
});

describe('DocsEditor', () => {
  it('connects to the same-origin /collab URL with the org id and the page document name', async () => {
    renderEditor();

    /* The first render shows "Connecting…" (provider is null until the
       hook's effect runs), then the editor mounts. */
    await waitFor(() => {
      expect(screen.getByTitle('Bold')).toBeInTheDocument();
    });

    expect(hoisted.instances).toHaveLength(1);
    expect(hoisted.instances[0]).toBeDefined();
    const provider = hoisted.instances[0];
    if (provider === undefined) throw new Error('expected a provider instance');
    expect(provider.options.url).toBe(`ws://localhost:3000/collab?orgId=${ORG_ID}`);
    expect(provider.options.name).toBe(`page:${PAGE_ID}`);
  });

  it('binds the editor to the Yjs "content" fragment the server compacts', async () => {
    renderEditor();

    await waitFor(() => {
      expect(screen.getByTitle('Bold')).toBeInTheDocument();
    });

    /* Collaboration's ySyncPlugin materializes the configured fragment on
       the shared Y.Doc at mount — proving `field: 'content'` was wired,
       which is the exact fragment `apps/collab/src/compaction.ts` reads. */
    const provider = hoisted.instances[0];
    if (provider === undefined) throw new Error('expected a provider instance');
    expect(provider.document.share.has('content')).toBe(true);
    expect(provider.document.share.has('default')).toBe(false);
  });

  it('destroys the provider when the editor unmounts', async () => {
    const view = renderEditor();

    await waitFor(() => {
      expect(screen.getByTitle('Bold')).toBeInTheDocument();
    });

    const provider = hoisted.instances[0];
    if (provider === undefined) throw new Error('expected a provider instance');
    expect(provider.destroyed).toBe(false);

    view.unmount();
    expect(provider.destroyed).toBe(true);
  });
});
