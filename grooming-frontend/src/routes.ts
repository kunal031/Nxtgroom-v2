/**
 * Maps each screen to a real URL.
 *
 * Every page previously rendered at "/", so a refresh always dropped the user
 * back to Attendance, the browser's back button left the app entirely, and no
 * screen could be linked to or bookmarked.
 *
 * A full router is not warranted for a fixed set of flat screens with no path
 * parameters, so this is a two-way mapping over the History API. The Vercel
 * rewrite already serves index.html for these paths, so deep links load.
 */

export const TABS = {
  OVERVIEW: 'overview',
  DAILY_RECORDS: 'daily-records',
  INSTRUCTOR_DETAIL: 'instructor-detail',
  UNIDENTIFIED: 'unidentified',
  INSTRUCTORS: 'instructor-management',
  USERS: 'boa-management',
  SETTINGS: 'settings',
} as const;

export type Tab = (typeof TABS)[keyof typeof TABS];

/** Canonical path for each tab. The order here is the order of resolution. */
const TAB_TO_PATH: Record<Tab, string> = {
  [TABS.OVERVIEW]: '/attendance',
  [TABS.DAILY_RECORDS]: '/daily-records',
  [TABS.INSTRUCTOR_DETAIL]: '/daily-records/record',  // suffixed with the record id
  [TABS.UNIDENTIFIED]: '/unidentified',
  [TABS.INSTRUCTORS]: '/instructors',
  [TABS.USERS]: '/users',
  [TABS.SETTINGS]: '/settings',
};

const PATH_TO_TAB = new Map<string, Tab>(
  Object.entries(TAB_TO_PATH).map(([tab, path]) => [path, tab as Tab]),
);

/** Paths owned by the shell rather than by a tab. */
export const RESET_PASSWORD_PATH = '/reset-password';

export interface PublicReportRoute {
  token: string;
  kind: 'day' | 'week';
  date: string;
  /**
   * Which half of the day the link is for. Always set: a path with no suffix
   * is a check-in. Required rather than optional so a caller that forgets to
   * forward it fails to compile instead of quietly rendering the check-in.
   */
  half: 'checkin' | 'checkout';
}

/** The path segment naming a half, as it appears in an emailed link. */
export function halfSegment(half: 'checkin' | 'checkout'): string {
  return half === 'checkout' ? 'check-out' : 'check-in';
}

/** A public day-report link for one half of one day. */
export function publicDayReportPath(token: string, date: string, half: 'checkin' | 'checkout'): string {
  return `/reports/${encodeURIComponent(token)}/day/${date}/${halfSegment(half)}`;
}

/**
 * Matches /reports/<token>/day|week/<YYYY-MM-DD>, the links sent by email.
 * These are opened by instructors who have no account, so they are recognised
 * before the auth gate rather than by a tab.
 */
export function publicReportFromLocation(): PublicReportRoute | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(
    /^\/reports\/([A-Za-z0-9_-]{8,128})\/(day|week)\/(\d{4}-\d{2}-\d{2})(?:\/(check-in|check-out))?\/?$/,
  );
  if (!match) return null;
  return {
    token: match[1],
    kind: match[2] as 'day' | 'week',
    date: match[3],
    // A link without a half is a check-in: that is what every link already
    // sent out points at, and they must keep working.
    half: match[4] === 'check-out' ? 'checkout' : 'checkin',
  };
}

export function pathForTab(tab: string, recordId?: string): string {
  const base = TAB_TO_PATH[tab as Tab] ?? TAB_TO_PATH[TABS.OVERVIEW];
  // The detail view addresses one record, so its id belongs in the URL:
  // without it a refresh or a shared link has nothing to render.
  if (tab === TABS.INSTRUCTOR_DETAIL && recordId) {
    return `${base}/${encodeURIComponent(recordId)}`;
  }
  return base;
}

/** The record id from /daily-records/record/<id>, or null. */
export function recordIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/daily-records\/record\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Resolves a URL to a tab. Unknown paths fall back to Attendance rather than
 * rendering nothing, so a stale bookmark still lands somewhere useful.
 */
export function tabForPath(pathname: string): Tab {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/' || normalized === '') return TABS.OVERVIEW;
  // A record id follows the detail path, so match the prefix before the map.
  if (/^\/daily-records\/record(\/|$)/.test(normalized)) return TABS.INSTRUCTOR_DETAIL;
  return PATH_TO_TAB.get(normalized) ?? TABS.OVERVIEW;
}

export function currentTabFromLocation(): Tab {
  if (typeof window === 'undefined') return TABS.OVERVIEW;
  return tabForPath(window.location.pathname);
}

/**
 * Pushes a tab's URL without reloading. Replacing rather than pushing when the
 * path is unchanged keeps repeated clicks on the active item out of history.
 */
export function pushTabPath(tab: string, recordId?: string): void {
  if (typeof window === 'undefined') return;
  const path = pathForTab(tab, recordId);
  if (window.location.pathname === path) return;
  window.history.pushState({ tab }, '', path);
}

/** Rewrites the current entry, used to normalise "/" to "/attendance" on load. */
export function replaceTabPath(tab: string, recordId?: string): void {
  if (typeof window === 'undefined') return;
  const path = pathForTab(tab, recordId);
  if (window.location.pathname === path) return;
  window.history.replaceState({ tab }, '', path);
}
