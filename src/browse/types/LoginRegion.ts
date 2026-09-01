/**
 * Where an account is allowed to sign in from.
 *
 * A rule is a place written from the outside in - country, then province, then
 * city - joined with a slash:
 *
 *   中国                 every sign-in from China
 *   中国/广东省          anywhere in Guangdong
 *   中国/广东省/深圳     Shenzhen and nowhere else in Guangdong
 *
 * A sign-in is allowed when *any* rule is a prefix of where it came from, which
 * is what lets one list mix countries and cities freely: the administrator
 * writes down the places they mean, at whatever depth they mean them, and a
 * broader rule simply covers more.
 *
 * The parts come from the same location service the sign-in log already uses,
 * so a rule can only ever be as precise as that service is - see `IPLocation`.
 */

/** Between the parts of one rule. Never appears inside a place name. */
export const LOGIN_REGION_SEPARATOR = '/';

/**
 * Country, then province, then city - and no deeper. The location service
 * answers with exactly these three, so a longer rule could never match
 * anything and is a mistake worth refusing rather than storing.
 */
export const MAX_LOGIN_REGION_DEPTH = 3;

/**
 * A rule is a place name and place names are short. The ceiling is here so
 * that a malformed body cannot grow the credentials file without bound.
 */
export const MAX_LOGIN_REGION_LENGTH = 120;

/**
 * How many places one account may be pinned to. Well past any real use, and
 * low enough that the check stays a walk over a short list on the sign-in path.
 */
export const MAX_LOGIN_REGIONS = 50;

/**
 * Where a sign-in came from, in the three parts the rules are written against.
 *
 * Any of them may be `null`: the service places some addresses only as far as
 * the country. A rule can only match as deep as the address is actually known,
 * which is deliberate - see {@link matchesLoginRegions}.
 */
export interface LoginRegionParts {
  country: string | null;
  province: string | null;
  city: string | null;
}

/** The code a region refusal carries, so the browser can tell it from a 403. */
export const LOGIN_REGION_BLOCKED_CODE = 'login_region_blocked';

/**
 * The parts of a rule, or `null` if there is nothing usable in it.
 *
 * Empty parts are dropped rather than kept as blanks, so `中国//深圳` reads as
 * `中国/深圳` instead of becoming a rule that can never match.
 */
export function parseLoginRegion(value: string): string[] | null {
  const parts = value
    .split(LOGIN_REGION_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => !!part);
  return parts.length > 0 ? parts : null;
}

/**
 * One rule as it should be stored, or `null` if it is not a rule at all.
 *
 * Throws for a rule that is well-formed but out of bounds - too long, or
 * deeper than the location service can answer - rather than quietly trimming
 * it, because a silently shortened rule is a silently *widened* permission.
 */
export function normalizeLoginRegion(value: unknown): string | null {
  if (typeof value !== 'string') {
    throw Error('Each allowed sign-in region must be a string');
  }
  if (value.length > MAX_LOGIN_REGION_LENGTH) {
    throw Error(`An allowed sign-in region must be at most ${MAX_LOGIN_REGION_LENGTH} characters`);
  }
  const parts = parseLoginRegion(value);
  if (!parts) {
    return null;
  }
  if (parts.length > MAX_LOGIN_REGION_DEPTH) {
    throw Error(
      `"${value}" is too specific - a region is a country, a province or a city ` +
      `(at most ${MAX_LOGIN_REGION_DEPTH} parts).`
    );
  }
  return parts.join(LOGIN_REGION_SEPARATOR);
}

/**
 * The list as it should be stored, or `null` for no restriction.
 *
 * An empty array survives as an empty array. It is the opposite of `null` and
 * deliberately reachable - it means no region at all, which is an account that
 * cannot sign in from anywhere. The same choice the creator restriction makes,
 * and for the same reason: folding "nothing" into "everything" is the wrong
 * way for a permission to fail.
 */
export function normalizeLoginRegions(regions: unknown): string[] | null {
  if (regions === null || regions === undefined) {
    return null;
  }
  if (!Array.isArray(regions)) {
    throw Error('"loginRegions" must be an array of regions, or null for no restriction');
  }
  const normalized = regions
    .map((region) => normalizeLoginRegion(region))
    .filter((region): region is string => region !== null);
  const unique = [ ...new Set(normalized) ];
  if (unique.length > MAX_LOGIN_REGIONS) {
    throw Error(`At most ${MAX_LOGIN_REGIONS} allowed sign-in regions`);
  }
  return unique;
}

/**
 * Whether one rule covers a place.
 *
 * The rule must be a prefix of the place, part for part. `中国/广东省` covers
 * every city in Guangdong; `中国/广东省/深圳` covers only Shenzhen.
 *
 * A rule deeper than what is known about the address does *not* match: if the
 * service placed a sign-in only as far as `中国`, a rule naming a city has not
 * been satisfied, and treating "unknown" as "matches" would let a city rule be
 * cleared by an address nobody can actually place that precisely.
 *
 * Compared case-insensitively, which matters only for the Latin-script names -
 * the service answers in Chinese for the rest.
 */
export function matchesLoginRegion(parts: LoginRegionParts, rule: string): boolean {
  const wanted = parseLoginRegion(rule);
  if (!wanted) {
    return false;
  }
  const actual = [ parts.country, parts.province, parts.city ];
  for (const [ index, part ] of wanted.entries()) {
    const here = actual[index];
    if (!here || here.toLowerCase() !== part.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a place is allowed by a list of rules.
 *
 * `null` is no restriction and allows everything. An empty list allows
 * nothing, which is what an empty list says.
 */
export function matchesLoginRegions(
  parts: LoginRegionParts,
  allowed: string[] | null
): boolean {
  if (allowed === null) {
    return true;
  }
  return allowed.some((rule) => matchesLoginRegion(parts, rule));
}

/**
 * A place written as the deepest rule that matches it, or `null` if it cannot
 * be written as one at all.
 *
 * Stops at the first part the service did not give, rather than closing the
 * gap: a place known as a country and a city but not a province would
 * otherwise be written `中国/深圳`, which reads as - and would match as - a
 * *province* named 深圳. Dropping the city is the honest answer.
 */
export function loginRegionPath(parts: LoginRegionParts): string | null {
  const path: string[] = [];
  for (const part of [ parts.country, parts.province, parts.city ]) {
    if (!part) {
      break;
    }
    path.push(part);
  }
  return path.length > 0 ? path.join(LOGIN_REGION_SEPARATOR) : null;
}

/** A rule as it reads to a person - `中国/广东省/深圳` as `中国 广东省 深圳`. */
export function describeLoginRegion(rule: string): string {
  return (parseLoginRegion(rule) || []).join(' ');
}

/** A place as it reads to a person, as deep as it is actually known. */
export function describeLoginRegionParts(parts: LoginRegionParts): string {
  return [ parts.country, parts.province, parts.city ]
    .filter((part): part is string => !!part)
    // The province is repeated as the city name for the municipalities, and
    // "上海市 上海市" reads like a mistake.
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(' ');
}
