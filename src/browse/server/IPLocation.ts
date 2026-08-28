/**
 * Where an address is, for the sign-in log.
 *
 * Looked up over the network rather than shipped as a database: an offline
 * GeoIP file would be tens of megabytes to carry and stale the day after it is
 * built, for a feature that fills in ten rows on one administrator's page.
 *
 * Nothing here is ever called while somebody is signing in. A login must not
 * wait on - or fail because of - a third party's service, so the address is
 * recorded immediately and the place is worked out later, when the log is
 * read.
 */

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

/** What the service accepts in one batch. */
const MAX_BATCH = 100;

export interface IPLocation {
  /** Already joined for display - "中国 广东省 深圳". */
  place: string | null;
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
export async function lookupIPLocations(ips: string[]): Promise<Map<string, IPLocation>> {
  const found = new Map<string, IPLocation>();
  const targets = [ ...new Set(ips.filter((ip) => ip && !localPlace(ip))) ].slice(0, MAX_BATCH);
  if (targets.length === 0) {
    return found;
  }
  const response = await fetch(LOOKUP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(targets),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
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
    const place = [ row.country, row.regionName, row.city ]
      .map((part) => (part || '').trim())
      .filter((part) => !!part)
      // The province is usually repeated as the city name for the
      // municipalities, and "上海 上海" reads like a mistake.
      .filter((part, index, parts) => parts.indexOf(part) === index)
      .join(' ');
    found.set(row.query, {
      place: place || null,
      isp: (row.isp || '').trim() || null
    });
  }
  return found;
}
