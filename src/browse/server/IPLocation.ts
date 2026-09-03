/**
 * Where an address is, for the sign-in log and for the region restriction.
 *
 * Looked up over the network rather than shipped as a database: an offline
 * GeoIP file would be tens of megabytes to carry and stale the day after it is
 * built, for a feature that fills in ten rows on one administrator's page.
 *
 * This used to be reached only when the log was read, never while somebody was
 * signing in. Restricting an account to certain regions changes that: the
 * server cannot decide whether to let someone in without knowing where they
 * are, so a sign-in by an account that carries a restriction now waits here.
 *
 * The wait is short (`LOGIN_LOOKUP_TIMEOUT_MS`) and it is skipped entirely for
 * an unrestricted account and for any address already in the log's cache, so
 * in practice only a genuinely new address ever pays for one.
 *
 * A lookup that fails does **not** let the sign-in through. It used to, and
 * that was the whole of the restriction's value: anybody arriving while this
 * service was unreachable was simply allowed in. The reasoning for the
 * reversal, and what keeps it from being a lockout, is on `LoginRegionGuard`.
 */

import { type LoginRegionParts } from '../types/LoginRegion.js';

/**
 * Only the fields that are actually shown, because the service bills a
 * response by what is asked for and the rest would just be noise in the cache
 * file. Places come back in Chinese, which is who this server is run for.
 */
const LOOKUP_ENDPOINT =
  'http://ip-api.com/batch?lang=zh-CN&fields=status,query,country,regionName,city,isp';

/**
 * Short on purpose. The administrator is waiting on this, and a log with the
 * places missing is far better than a page that hangs.
 */
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * The same, for a lookup that a sign-in is waiting on.
 *
 * Half the other one, because the person waiting on this is at a login form
 * rather than reading a table, and a slow answer here costs them the wait
 * whether or not it ever arrives.
 *
 * Overshooting it *is* a refusal now, which is why it is a per-attempt budget
 * rather than the whole of one - see {@link LOGIN_LOOKUP_ATTEMPTS}.
 */
export const LOGIN_LOOKUP_TIMEOUT_MS = 2500;

/**
 * How many times a lookup a permission check is waiting on is tried before it
 * is given up on.
 *
 * Two, and no more. This service is plain HTTP on a free tier and drops the
 * occasional request; with a refusal riding on the answer, one dropped request
 * would be somebody turned away from their own account. A second attempt costs
 * nothing to anyone who does not need it, and the worst case stays inside the
 * few seconds a person will wait at a login form.
 *
 * It is deliberately not more than two. Beyond that the wait becomes the
 * problem, and a service that has failed twice in five seconds is down rather
 * than busy.
 */
export const LOGIN_LOOKUP_ATTEMPTS = 2;

/** What the service accepts in one batch. */
const MAX_BATCH = 100;

export interface IPLocation {
  /** Already joined for display - "中国 广东省 深圳". */
  place: string | null;
  /**
   * Country and province only - "中国 广东省" - for telling one sign-in
   * region from another. A move between cities of one province is not a
   * region change. Absent on entries cached before this existed, which the
   * log store treats as "ask again".
   */
  region?: string | null;
  /**
   * The same place unjoined, which is what the region restriction matches
   * against - a rule naming a province has to be told apart from one naming a
   * city, and a single joined string cannot say which is which.
   *
   * Absent on entries cached before this existed, which the log store treats
   * as "ask again" exactly as it does for {@link IPLocation.region}.
   */
  parts?: LoginRegionParts | null;
  isp: string | null;
}

interface LookupRow {
  status?: string;
  query?: string;
  country?: string;
  regionName?: string;
  city?: string;
  isp?: string;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./
];

/** The shared address space handed out by carriers, which is nobody's LAN. */
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * The address as it should be stored and shown.
 *
 * Express reports an IPv4 client on a dual-stack listener in its mapped form
 * (`::ffff:1.2.3.4`), which is the same client as `1.2.3.4` and would
 * otherwise take a second cache entry and read as a different machine.
 */
export function normalizeIP(ip: string | null | undefined): string {
  if (!ip) {
    return '';
  }
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

/**
 * What to show for an address that no lookup can place, or `null` if it is an
 * ordinary public one.
 *
 * Answered here rather than by asking the service, both to save the call and
 * because "reserved range" is a worse answer than saying plainly that the
 * request came from inside the house.
 */
export function localPlace(ip: string): string | null {
  if (!ip) {
    return null;
  }
  if (ip === '::1' || ip === '::' || ip === 'localhost') {
    return '本机';
  }
  // Unique-local and link-local IPv6, the equivalents of the two blocks below.
  if (/^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) {
    return '局域网';
  }
  if (PRIVATE_V4.some((pattern) => pattern.test(ip))) {
    return ip.startsWith('127.') ? '本机' : '局域网';
  }
  if (CGNAT_V4.test(ip)) {
    return '运营商 NAT';
  }
  return null;
}

/**
 * Places as many of these addresses as the service will say something about.
 *
 * Addresses it cannot answer for are simply left out of the result rather than
 * being returned as blanks - the caller caches what comes back, and caching
 * "unknown" would mean never asking again.
 *
 * Throws if the service cannot be reached at all, which the caller is expected
 * to treat as "no places this time" rather than as a failure of the log.
 */
export async function lookupIPLocations(
  ips: string[],
  timeoutMs = LOOKUP_TIMEOUT_MS
): Promise<Map<string, IPLocation>> {
  const found = new Map<string, IPLocation>();
  const targets = [ ...new Set(ips.filter((ip) => ip && !localPlace(ip))) ].slice(0, MAX_BATCH);
  if (targets.length === 0) {
    return found;
  }
  const response = await fetch(LOOKUP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(targets),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw Error(`Location service answered ${response.status}`);
  }
  const rows = await response.json() as LookupRow[];
  if (!Array.isArray(rows)) {
    throw Error('Location service answered with something other than a list');
  }
  for (const row of rows) {
    if (row?.status !== 'success' || !row.query) {
      continue;
    }
    // Kept apart as well as joined: the region restriction has to tell a rule
    // naming a province from one naming a city, and the joined form below
    // drops a repeated part, so it cannot be taken back apart afterwards.
    const parts: LoginRegionParts = {
      country: (row.country || '').trim() || null,
      province: (row.regionName || '').trim() || null,
      city: (row.city || '').trim() || null
    };
    const place = [ row.country, row.regionName, row.city ]
      .map((part) => (part || '').trim())
      .filter((part) => !!part)
      // The province is usually repeated as the city name for the
      // municipalities, and "上海 上海" reads like a mistake.
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .join(' ');
    const region = [ row.country, row.regionName ]
      .map((part) => (part || '').trim())
      .filter((part) => !!part)
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .join(' ');
    found.set(row.query, {
      place: place || null,
      region: region || null,
      parts,
      isp: (row.isp || '').trim() || null
    });
  }
  return found;
}
