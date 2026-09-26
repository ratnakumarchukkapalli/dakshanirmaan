import { describe, expect, it } from 'vitest';
import { MENU_EXTRAS, NAV_HREF, RAIL_ADMIN, RAIL_MAIN, isActive, visibleFor } from './nav';

describe('isActive', () => {
  it('matches the exact route and anything nested under it', () => {
    expect(isActive('/sales', '/sales')).toBe(true);
    expect(isActive('/sales/abc-123', '/sales')).toBe(true);
    expect(isActive('/sales/abc-123/view', '/sales')).toBe(true);
  });
  it('is prefix-safe: a sibling that merely starts with the same letters is not active', () => {
    expect(isActive('/salesx', '/sales')).toBe(false);
    expect(isActive('/sales-report', '/sales')).toBe(false);
    expect(isActive('/settings', '/sales')).toBe(false);
  });
  it('does not treat a parent route as active for its child link', () => {
    expect(isActive('/sales', '/sales/new')).toBe(false);
  });
  it('the root link is active on the root only, never on every page', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/sales', '/')).toBe(false);
    expect(isActive('/parties/1', '/')).toBe(false);
  });
});

describe('visibleFor', () => {
  it('an owner sees everything', () => {
    expect(visibleFor('admin', MENU_EXTRAS)).toEqual(MENU_EXTRAS);
    expect(visibleFor('admin', RAIL_ADMIN)).toEqual(RAIL_ADMIN);
  });
  it('a counter user does not see settings or staff (salaries are owner-only), and keeps the order of the rest', () => {
    expect(visibleFor('user', MENU_EXTRAS)).toEqual(['purchases', 'reports']);
    expect(visibleFor('user', RAIL_ADMIN)).toEqual(['reports']);
    expect(visibleFor('user', ['settings'])).toEqual([]);
  });
  it('leaves the everyday screens alone for a counter user', () => {
    expect(visibleFor('user', RAIL_MAIN)).toEqual(RAIL_MAIN.filter((k) => k !== 'staff'));
  });
  it('does not change the list it was given', () => {
    const keys = [...MENU_EXTRAS];
    visibleFor('user', keys);
    expect(keys).toEqual(MENU_EXTRAS);
  });
});

describe('NAV_HREF', () => {
  it('gives every entry its own route, root only for the dashboard', () => {
    const hrefs = Object.values(NAV_HREF);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(NAV_HREF.dashboard).toBe('/');
  });
});
