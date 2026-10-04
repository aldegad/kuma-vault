// Large-file path contract shared by the server receive rules, the generated root
// `.gitattributes`, and (later) the rewrite/autosave tools.
//
// Which paths go to LFS is decided by ONE extension list, never by
// size. Extensions are compared lower-case everywhere (macOS clones run core.ignorecase=true,
// the server false), so the generated `.gitattributes` uses bracket patterns that match the
// same set on both sides.

export const LFS_EXTENSIONS = Object.freeze([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "heic", "psd", "aseprite", "sai",
  // 3D
  "blend", "blend1", "glb",
  // video
  "mp4", "mov", "webm", "mkv", "avi",
  // audio
  "mp3", "wav", "m4a", "ogg",
  // documents
  "pdf", "hwp", "docx", "xlsx", "pptx", "xls",
  // archives
  "zip", "zst", "gz", "tgz", "7z", "tar", "aar",
  // fonts
  "ttf", "otf", "woff2",
  // arrays / databases
  "npy", "npz", "sqlite",
  // notebooks (text, but they embed images and grow large)
  "ipynb",
]);

const LFS_EXTENSION_SET = new Set(LFS_EXTENSIONS);

/** Lower-case extension of the path's basename (`a/b.PNG` -> `png`), or "" when there is none. */
export function pathExtension(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function isLfsPath(path) {
  return LFS_EXTENSION_SET.has(pathExtension(path));
}

function caseInsensitiveGlob(extension) {
  return [...extension]
    .map((ch) => (/[a-z]/.test(ch) ? `[${ch}${ch.toUpperCase()}]` : ch))
    .join("");
}

/** The LFS block of the generated root `.gitattributes`, one line per extension. */
export function renderLfsGitattributesLines() {
  return LFS_EXTENSIONS.map((ext) => `*.${caseInsensitiveGlob(ext)} filter=lfs diff=lfs merge=lfs -text`);
}

// --- LFS pointer files (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md) ---

export const LFS_POINTER_VERSION = "https://git-lfs.github.com/spec/v1";
export const LFS_POINTER_MAX_BYTES = 1024;
const OID_PATTERN = /^[0-9a-f]{64}$/;

export function isLfsOid(value) {
  return typeof value === "string" && OID_PATTERN.test(value);
}

/**
 * Parse a canonical LFS pointer (the exact three lines git-lfs writes). Anything else —
 * extension keys, reordered keys, CRLF, trailing bytes, an oversized size — is not a pointer.
 * Returns `{ oid, size }` or null.
 */
export function parseLfsPointer(buffer) {
  if (!buffer || buffer.length === 0 || buffer.length > LFS_POINTER_MAX_BYTES) return null;
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const match = /^version (\S+)\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]{0,15})\n$/.exec(text);
  if (!match || match[1] !== LFS_POINTER_VERSION) return null;
  const size = Number(match[3]);
  if (!Number.isSafeInteger(size)) return null;
  return { oid: match[2], size };
}

export function renderLfsPointer(oid, size) {
  return `version ${LFS_POINTER_VERSION}\noid sha256:${oid}\nsize ${size}\n`;
}

// --- junk paths (the generated trash/derived .gitignore block, receive rule 6) ---
//
// gitignore syntax. One list for the generated `.gitignore` block, the sync daemon and the
// server default (`server.json` `junkPatterns` may replace it on the server). The lock and
// temp names come from the writers that put them inside a vault: the per-file commit lock
// `.<name>.commit-lock`, the plan checkpoint lock `<file>.kuma-plan-checkpoint.lock`, and the
// write-then-rename temps `<file>.<pid>.<uuid|ms>.tmp`, `<file>.tmp.<pid>[.<ts>]`,
// `<file>.tmp-<suffix>`, `<file>.tmp-journal`.
export const DEFAULT_JUNK_PATTERNS = Object.freeze([
  ".fts/",
  "*.commit-lock",
  ".*.commit-lock",
  "*.kuma-plan-checkpoint.lock",
  "*.tmp",
  "*.tmp.*",
  "*.tmp-*",
  "*.tmp-journal",
  ".~*",
  "*.gc-backup-*",
  ".DS_Store",
  "__pycache__/",
  "*.pyc",
]);
