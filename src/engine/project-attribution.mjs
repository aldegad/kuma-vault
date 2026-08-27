// Project attribution (engine-owned, pure).
//
// The host used to supply project ids by reading its own `~/.kuma/projects.json`
// registry + package.json + configured defaults (the C4 seam). That data source is
// host-specific, so the engine takes the *resolved* list of known project ids as an
// injected parameter instead. On a generic tree the list is empty and no source is
// attributed to a project. The host passes its own resolved list in.
//
// These functions are pure over the injected `knownProjectIds` array — no filesystem,
// no env, no host imports — which also makes the ingest tests deterministic.

function normalizeId(value) {
  return String(value ?? "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Dedupe/clean the injected ids and sort longest-first so the most specific
 * project id wins a prefix/content match.
 */
export function normalizeKnownProjectIds(knownProjectIds = []) {
  return Array.from(new Set((knownProjectIds ?? []).map(normalizeId)))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

/**
 * Infer a project id from a source slug of the form `<projectId>-<rest>`.
 * Returns the longest matching known project id, or null.
 */
export function inferProjectIdFromSlugPrefix(sourceSlug, knownProjectIds = []) {
  const normalizedSlug = normalizeId(sourceSlug);
  if (!normalizedSlug) {
    return null;
  }
  return normalizeKnownProjectIds(knownProjectIds)
    .find((projectId) => normalizedSlug.startsWith(`${projectId}-`)) ?? null;
}

/**
 * Detect a project id mentioned in a document's text (title/summary/body/etc.).
 * Matches a known project id as a whole token, tolerating `-`/`_`/space between
 * its parts (e.g. "acme app" matches "acme-app").
 */
export function detectProjectIdFromContentText(haystackText, knownProjectIds = []) {
  const haystack = String(haystackText ?? "").toLowerCase();
  for (const projectId of normalizeKnownProjectIds(knownProjectIds)) {
    const flexibleProjectPattern = projectId
      .toLowerCase()
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => escapeRegExp(part))
      .join("[-_\\s]*");
    const pattern = new RegExp(`(^|[^a-z0-9])${flexibleProjectPattern}([^a-z0-9]|$)`, "u");
    if (pattern.test(haystack)) {
      return projectId;
    }
  }
  return null;
}
