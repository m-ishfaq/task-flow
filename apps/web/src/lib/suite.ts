/**
 * The Design Bible's suite spectrum (§01) — one hue per product module, kept
 * in exactly one place so the sidebar, the header, and anything else that
 * wants to say "you are in Chat right now" all agree on what color Chat is.
 *
 * The tokens themselves (`--color-suite-work/chat/docs/calls/people`) live in
 * `styles.css`'s `@theme` block; this file is only the TypeScript-side
 * vocabulary for referring to them.
 */
export type Suite = 'work' | 'chat' | 'docs' | 'calls' | 'people';

/**
 * Every literal Tailwind class string this app needs per suite, spelled out
 * in full rather than built with template interpolation
 * (`` `text-suite-${suite}` ``). Tailwind's scanner finds candidate classes by
 * matching literal text in source files — a dynamically-assembled class name
 * is invisible to it, so it would compile away silently: present in dev
 * (where Vite serves every possible utility) and missing from a production
 * build, which only ships the classes it could actually see.
 */
export const SUITE_STYLES: Readonly<
  Record<
    Suite,
    {
      /** The suite's own text color, for a label or icon (`currentColor`). */
      readonly text: string;
      /** Active nav-row tint + text + hover, for a sidebar-style link. */
      readonly active: string;
      /** The `before:` gradient bar half of an active nav row's indicator. */
      readonly bar: string;
    }
  >
> = {
  work: {
    text: 'text-suite-work',
    active: 'bg-suite-work/10 text-suite-work hover:bg-suite-work/10 hover:text-suite-work',
    bar: 'before:from-suite-work before:to-suite-work/0',
  },
  chat: {
    text: 'text-suite-chat',
    active: 'bg-suite-chat/10 text-suite-chat hover:bg-suite-chat/10 hover:text-suite-chat',
    bar: 'before:from-suite-chat before:to-suite-chat/0',
  },
  docs: {
    text: 'text-suite-docs',
    active: 'bg-suite-docs/10 text-suite-docs hover:bg-suite-docs/10 hover:text-suite-docs',
    bar: 'before:from-suite-docs before:to-suite-docs/0',
  },
  calls: {
    text: 'text-suite-calls',
    active: 'bg-suite-calls/10 text-suite-calls hover:bg-suite-calls/10 hover:text-suite-calls',
    bar: 'before:from-suite-calls before:to-suite-calls/0',
  },
  people: {
    text: 'text-suite-people',
    active: 'bg-suite-people/10 text-suite-people hover:bg-suite-people/10 hover:text-suite-people',
    bar: 'before:from-suite-people before:to-suite-people/0',
  },
};

/**
 * Which suite a path belongs to, or `undefined` for a path that is not a
 * product module — "where you start" (My tasks, Search, Assistant),
 * Settings, and configuration surfaces all stay the generic accent rather
 * than claiming a hue that would suggest they are one of the five modules.
 */
export function suiteForPath(pathname: string): Suite | undefined {
  if (pathname.startsWith('/chat')) return 'chat';
  if (pathname.startsWith('/docs')) return 'docs';
  if (pathname.startsWith('/calls')) return 'calls';
  if (pathname.startsWith('/people')) return 'people';
  if (pathname.startsWith('/boards/') || pathname.startsWith('/projects')) return 'work';
  return undefined;
}
