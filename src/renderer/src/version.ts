/**
 * Version display.
 *
 * package.json has to hold a valid semver string — npm and electron-builder
 * both reject anything else — so the real version is `0.90.0-beta`. What the
 * user sees is `0.90b`, derived from it here rather than written down twice.
 * There is one source of truth, and it is package.json.
 */

/** `0.90.0-beta` -> `0.90b`. Anything unexpected is shown unchanged. */
export function displayVersion(version: string): string {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:-([a-z]+))?/i.exec(version);
  if (!match) return version;

  const [, major, minor, tag] = match;
  const suffix = tag ? tag.charAt(0).toLowerCase() : '';
  return `${major}.${minor}${suffix}`;
}

/** Whether this build is a pre-release, for the beta marker. */
export function isPrerelease(version: string): boolean {
  return /-/.test(version);
}
