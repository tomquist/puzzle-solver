import { describe, expect, it } from 'vitest';
import { href, parseRoute, routePuzzleId, routeToHash, type Route } from './routes';

describe('parseRoute', () => {
  it('parses home variants', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
  });

  it('parses the wizard', () => {
    expect(parseRoute('#/new')).toEqual({ name: 'new' });
  });

  it('parses puzzle tabs with scan as default', () => {
    expect(parseRoute('#/puzzle/abc')).toEqual({ name: 'puzzle', id: 'abc', tab: 'scan' });
    expect(parseRoute('#/puzzle/abc/picture')).toEqual({ name: 'puzzle', id: 'abc', tab: 'picture' });
    expect(parseRoute('#/puzzle/abc/history/')).toEqual({ name: 'puzzle', id: 'abc', tab: 'history' });
    expect(parseRoute('#/puzzle/abc/settings')).toEqual({ name: 'puzzle', id: 'abc', tab: 'settings' });
  });

  it('parses scan results and decodes ids', () => {
    expect(parseRoute('#/puzzle/a%20b/scan/s-1')).toEqual({ name: 'scan', id: 'a b', scanId: 's-1' });
  });

  it('ignores query strings', () => {
    expect(parseRoute('#/puzzle/abc/picture?x=1')).toEqual({ name: 'puzzle', id: 'abc', tab: 'picture' });
  });

  it('reports unknown paths', () => {
    expect(parseRoute('#/nope')).toEqual({ name: 'notFound', path: '/nope' });
    expect(parseRoute('#/puzzle/abc/bogus')).toEqual({ name: 'notFound', path: '/puzzle/abc/bogus' });
    expect(parseRoute('#/puzzle')).toEqual({ name: 'notFound', path: '/puzzle' });
  });
});

describe('routeToHash', () => {
  it('round-trips', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'new' },
      { name: 'puzzle', id: 'p 1', tab: 'scan' },
      { name: 'puzzle', id: 'p1', tab: 'settings' },
      { name: 'scan', id: 'p1', scanId: 's/2' },
    ];
    for (const r of routes) expect(parseRoute(routeToHash(r))).toEqual(r);
  });

  it('builds hrefs', () => {
    expect(href.home()).toBe('#/');
    expect(href.puzzle('x')).toBe('#/puzzle/x');
    expect(href.puzzle('x', 'history')).toBe('#/puzzle/x/history');
    expect(href.scan('x', 'y')).toBe('#/puzzle/x/scan/y');
  });

  it('finds the puzzle id of nested routes', () => {
    expect(routePuzzleId(parseRoute('#/puzzle/x/scan/y'))).toBe('x');
    expect(routePuzzleId(parseRoute('#/puzzle/x/picture'))).toBe('x');
    expect(routePuzzleId(parseRoute('#/new'))).toBeUndefined();
  });
});
