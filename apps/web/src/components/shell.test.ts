import { describe, expect, it } from 'vitest';
import { breadcrumbsFor } from './shell.js';

/**
 * `breadcrumbsFor` is the whole "which routes get which trail" decision —
 * pure, and the pure half is what this file tests directly rather than only
 * through a rendered `<Breadcrumbs>`, matching this codebase's own standing
 * "test the pure half" convention (`neighbours.test.ts`, `markdown-lite.test.ts`).
 */
describe('breadcrumbsFor', () => {
  it('is a single segment for a flat top-level page', () => {
    expect(breadcrumbsFor('/home', 'TaskFlow')).toEqual([{ label: 'My tasks' }]);
    expect(breadcrumbsFor('/search', 'TaskFlow')).toEqual([{ label: 'Search' }]);
    expect(breadcrumbsFor('/chat', 'TaskFlow')).toEqual([{ label: 'Chat' }]);
    expect(breadcrumbsFor('/assistant', 'TaskFlow')).toEqual([{ label: 'Assistant' }]);
    expect(breadcrumbsFor('/analytics', 'TaskFlow')).toEqual([{ label: 'Analytics' }]);
    expect(breadcrumbsFor('/automations', 'TaskFlow')).toEqual([{ label: 'Automations' }]);
    expect(breadcrumbsFor('/calls', 'TaskFlow')).toEqual([{ label: 'Calls' }]);
    expect(breadcrumbsFor('/account', 'TaskFlow')).toEqual([{ label: 'Account' }]);
  });

  it('nests a board under a clickable Projects segment', () => {
    expect(breadcrumbsFor('/boards/abc123', 'TaskFlow')).toEqual([
      { label: 'Projects', to: '/projects' },
      { label: 'Board' },
    ]);
  });

  it('nests a person profile under a clickable People segment', () => {
    expect(breadcrumbsFor('/people/user-1', 'TaskFlow')).toEqual([
      { label: 'People', to: '/people' },
      { label: 'Profile' },
    ]);
  });

  it('does not let /people/$userId fall through to the bare /people case', () => {
    const crumbs = breadcrumbsFor('/people/user-1', 'TaskFlow');
    expect(crumbs).toHaveLength(2);
  });

  it('nests audit log three under a clickable Settings segment', () => {
    expect(breadcrumbsFor('/settings/audit', 'TaskFlow')).toEqual([
      { label: 'Settings', to: '/settings' },
      { label: 'Audit log' },
    ]);
  });

  it('is a bare Settings segment for the settings page itself', () => {
    expect(breadcrumbsFor('/settings', 'TaskFlow')).toEqual([{ label: 'Settings' }]);
  });

  it('is three segments deep for a project sub-route', () => {
    expect(breadcrumbsFor('/projects/proj-1/sprints', 'TaskFlow')).toEqual([
      { label: 'Projects', to: '/projects' },
      { label: 'Project' },
      { label: 'Sprints' },
    ]);
    expect(breadcrumbsFor('/projects/proj-1/standup', 'TaskFlow')).toEqual([
      { label: 'Projects', to: '/projects' },
      { label: 'Project' },
      { label: 'Standup' },
    ]);
  });

  it('is two segments for a project settings page (no sub-route)', () => {
    expect(breadcrumbsFor('/projects/proj-1', 'TaskFlow')).toEqual([
      { label: 'Projects', to: '/projects' },
      { label: 'Project settings' },
    ]);
  });

  it('is a bare Projects segment for the projects list itself', () => {
    expect(breadcrumbsFor('/projects', 'TaskFlow')).toEqual([{ label: 'Projects' }]);
  });

  it('falls back to the product name for a genuinely unmatched route', () => {
    expect(breadcrumbsFor('/some-future-route', 'Acme Corp')).toEqual([{ label: 'Acme Corp' }]);
  });
});
