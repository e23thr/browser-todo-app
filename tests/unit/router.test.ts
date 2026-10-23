import { describe, expect, it } from 'vitest';

import {
  createRouter,
  hashToPath,
  matchPath,
  normalizePath,
  type RouteMatch,
  type RouterOptions,
} from '../../src/app/router';

interface FakeLocation {
  readonly options: RouterOptions;
  readonly emit: () => void;
  readonly setExternal: (hash: string) => void;
  readonly get: () => string;
  readonly listenerCount: () => number;
}

/** Deterministic stand-in for `window.location` + `hashchange` — no DOM required. */
function createFakeLocation(initial = '#/'): FakeLocation {
  let hash = initial;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    options: {
      getHash: () => hash,
      setHash: (next) => {
        hash = next;
        emit();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit,
    setExternal: (next) => {
      hash = next;
      emit();
    },
    get: () => hash,
    listenerCount: () => listeners.size,
  };
}

describe('normalizePath', () => {
  it('guarantees a leading slash', () => {
    expect(normalizePath('today')).toBe('/today');
  });

  it('collapses duplicate slashes and drops a trailing slash', () => {
    expect(normalizePath('//list//42/')).toBe('/list/42');
  });

  it('keeps the root path as root', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });
});

describe('hashToPath', () => {
  it('treats an empty hash as the root path', () => {
    expect(hashToPath('')).toBe('/');
    expect(hashToPath('#')).toBe('/');
  });

  it('strips the hash marker and query string', () => {
    expect(hashToPath('#/today')).toBe('/today');
    expect(hashToPath('#/list/42?filter=done')).toBe('/list/42');
  });

  it('returns an empty string for in-page anchors so the view is left alone', () => {
    expect(hashToPath('#main')).toBe('');
    expect(hashToPath('#/today')).not.toBe('');
  });
});

describe('matchPath', () => {
  it('matches a static route', () => {
    expect(matchPath('/today', '/today')).toEqual({});
  });

  it('captures named params', () => {
    expect(matchPath('/list/:id', '/list/42')).toEqual({ id: '42' });
    expect(matchPath('/list/:id/note/:noteId', '/list/42/note/7')).toEqual({
      id: '42',
      noteId: '7',
    });
  });

  it('percent-decodes captured params', () => {
    expect(matchPath('/list/:id', '/list/a%20b')).toEqual({ id: 'a b' });
  });

  it('rejects a different segment count, a different literal, or the root', () => {
    expect(matchPath('/list/:id', '/list/42/extra')).toBeNull();
    expect(matchPath('/list/:id', '/lists/42')).toBeNull();
    expect(matchPath('/', '/today')).toBeNull();
    expect(matchPath('/today', '/')).toBeNull();
  });

  it('tolerates a trailing slash on either side', () => {
    expect(matchPath('/today/', '/today')).toEqual({});
    expect(matchPath('/today', '/today/')).toEqual({});
  });
});

describe('createRouter', () => {
  const patterns = ['/', '/today', '/settings'];

  it('resolves the current hash on start', () => {
    const fake = createFakeLocation('#/settings');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);

    router.start();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pattern).toBe('/settings');
    expect(seen[0]?.path).toBe('/settings');
    router.dispose();
  });

  it('notifies on external hash changes and reports null for unknown routes', () => {
    const fake = createFakeLocation('#/');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);
    router.start();

    fake.setExternal('#/nope');
    expect(seen.at(-1)).toBeNull();

    fake.setExternal('#/today');
    expect(seen.at(-1)?.pattern).toBe('/today');
    router.dispose();
  });

  it('leaves the view untouched for in-page anchors such as the skip link', () => {
    const fake = createFakeLocation('#/today');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);
    router.start();

    fake.setExternal('#main');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.pattern).toBe('/today');
    router.dispose();
  });

  it('navigate() sets the hash and still resolves when the hash is unchanged', () => {
    const fake = createFakeLocation('#/');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);
    router.start();

    router.navigate('/settings');
    expect(fake.get()).toBe('#/settings');
    expect(seen.at(-1)?.pattern).toBe('/settings');

    const before = seen.length;
    router.navigate('/settings');
    expect(seen.length).toBe(before + 1);
    router.dispose();
  });

  it('navigate(..., { replace: true }) still resolves the route', () => {
    const fake = createFakeLocation('#/');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);
    router.start();

    router.navigate('/today', { replace: true });
    expect(seen.at(-1)?.pattern).toBe('/today');
    router.dispose();
  });

  it('dispose() unsubscribes so a dead router stops reacting', () => {
    const fake = createFakeLocation('#/');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);
    router.start();
    expect(fake.listenerCount()).toBe(1);

    router.dispose();
    expect(fake.listenerCount()).toBe(0);
    fake.setExternal('#/settings');
    expect(seen).toHaveLength(1);
  });

  it('start() is idempotent', () => {
    const fake = createFakeLocation('#/');
    const seen: (RouteMatch | null)[] = [];
    const router = createRouter(patterns, (match) => seen.push(match), fake.options);
    router.start();
    router.start();
    expect(seen).toHaveLength(1);
    router.dispose();
  });
});
