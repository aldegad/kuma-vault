// What a client checkout can write — receive rule 2 (docs/server.md, "What a checkout can
// write"). The clients are macOS (APFS, case- and normalization-insensitive) and Linux (ext4,
// xfs, btrfs). A path one of them cannot write is taken in by the server but breaks `tree/` and
// every clone of that client, so the server refuses it. Each axis below was measured with a
// real `git clone` on both (the table in docs/server.md).
//
//   encoding    git paths are bytes; APFS refuses a name that is not UTF-8 (EILSEQ)
//   code points APFS refuses code points its Unicode version does not assign, and noncharacters
//   NFC         APFS keeps a name as written but matches it canonically, so NFC and NFD
//               spellings collide; only NFC is taken
//   case        APFS matches names with full Unicode case folding (ß = ss, ς = σ, ﬀ = ff), so
//               two paths with one caseKey collide in a macOS checkout
//   components  git never checks out an empty, `.`, `..` or `.git`-like component (HFS+ ignorable
//               code points dropped), nor a `.gitmodules` that is a symlink
//   named fork  macOS reads `<x>/..namedfork/rsrc` as the resource fork of `<x>`, so no
//               `..namedfork` component is taken
//   length      components <= NAME_MAX_BYTES, paths <= PATH_MAX_BYTES, symlink targets <=
//               CHECKOUT_LINK_TARGET_MAX_BYTES

import { ASSIGNED_RANGES, CASE_FOLDS, UNICODE_VERSION } from "./unicode-tables.mjs";

// Checkout limits of the clients:
//   component  ext4 NAME_MAX is 255 bytes; APFS allows 255 characters, which is never fewer bytes
//   symlink    macOS symlink(2) takes at most 1023 bytes (PATH_MAX 1024 with the NUL); Linux 4095
//   path       macOS PATH_MAX 1024 with the NUL: 768 bytes leave 255 for the clone directory
//              the path is opened under (absolute paths), Linux allows 4095
// Lengths are of the path as stored (NFC): APFS and Linux store names as written.
export const NAME_MAX_BYTES = 255;
export const CHECKOUT_LINK_TARGET_MAX_BYTES = 1023;
export const PATH_MAX_BYTES = 768;
// `.git` itself, plus the names NTFS resolves to it (trailing dots/spaces, the 8.3 short name),
// read after dropping the code points HFS+ ignores (git on macOS refuses `.g<U+200C>it` too)
const DOTGIT_COMPONENT = /^(\.git[. ]*|git~1)$/i;
const DOTGITMODULES = /^\.gitmodules$/i;
// macOS path lookup takes a path ending in `/..namedfork/rsrc` as the resource fork of the file
// before it (xnu vfs_cache.c, _PATH_RSRCFORKSPEC; compared byte for byte). A directory has none,
// so a checkout fails on `d/..namedfork/rsrc` and on `d/..namedfork/rsrc/x`; at the top of the
// tree git's relative open writes it, but any absolute path to it reads the clone's fork
// (ENOENT). The whole component is refused rather than the `rsrc` spellings: it has no other use,
// and the rule then does not depend on how a client tool spells the path.
const NAMED_FORK = "..namedfork";
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
const asGitReads = (part) => part.replace(HFS_IGNORABLE, "");

// fatal: invalid UTF-8 throws instead of turning into U+FFFD (which is NFC and would pass);
// ignoreBOM: a leading U+FEFF is part of the name, not a byte order mark to drop
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Why a runtime cannot judge rule 2, or null. NFC and the case key come from the runtime's ICU,
 * the tables from Unicode UNICODE_VERSION: an older ICU leaves code points of the newer version
 * without their decompositions, so it would take an NFD name as NFC and give a pair APFS matches
 * two keys. Normalization is stable for assigned code points, so any later version agrees.
 */
export function unicodeRuntimeProblem(runtime = process.versions.unicode) {
  const [major, minor] = UNICODE_VERSION.split(".").map(Number);
  const [rMajor, rMinor] = String(runtime ?? "").split(".").map(Number);
  if (rMajor > major || (rMajor === major && rMinor >= minor)) return null;
  return `receive rule 2 needs a Node whose ICU knows Unicode ${major}.${minor} or later; this one has ${runtime ?? "no ICU"} (Node ${process.version})`;
}

const runtimeProblem = unicodeRuntimeProblem();
if (runtimeProblem) throw new Error(runtimeProblem);

const ASSIGNED = Uint32Array.from(
  ASSIGNED_RANGES.split(",")
    .filter(Boolean)
    .flatMap((range) => {
      const [lo, hi = lo] = range.split("-");
      return [parseInt(lo, 16), parseInt(hi, 16)];
    }),
);

const FOLDS = new Map(
  CASE_FOLDS.split(",")
    .filter(Boolean)
    .map((entry) => {
      const [from, to] = entry.split(":");
      return [parseInt(from, 16), String.fromCodePoint(...to.split(".").map((h) => parseInt(h, 16)))];
    }),
);

function isAssigned(cp) {
  let lo = 0;
  let hi = ASSIGNED.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ASSIGNED[2 * mid]) hi = mid - 1;
    else if (cp > ASSIGNED[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function escapeBytes(bytes) {
  let out = "";
  for (const byte of bytes) out += byte >= 0x20 && byte < 0x7f && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`;
  return out;
}

/**
 * Decode a path as git stores it (bytes). Not UTF-8 -> `{ utf8: false }` and the path with
 * every byte outside printable ASCII written as `\xNN`, for messages and logs.
 */
export function decodePath(bytes) {
  try {
    return { path: UTF8.decode(bytes), utf8: true };
  } catch {
    return { path: escapeBytes(bytes), utf8: false };
  }
}

/**
 * The name APFS matches a path by: canonical caseless form, NFD(fold(NFD(path))) with Unicode
 * full case folding (Unicode 3.13, D145). Two paths with one key are one file on a Mac.
 */
export function caseKey(path) {
  let folded = "";
  for (const ch of path.normalize("NFD")) folded += FOLDS.get(ch.codePointAt(0)) ?? ch;
  return folded.normalize("NFD");
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** A symlink here is a `.gitmodules` git refuses to check out (fsck: gitmodulesSymlink). */
export function isDotGitmodules(path) {
  return DOTGITMODULES.test(asGitReads(path.slice(path.lastIndexOf("/") + 1)));
}

/** Rule 2 messages for one path (`utf8` from decodePath); empty when every client can write it. */
export function checkoutPathProblems(path, utf8 = true) {
  if (!utf8) return [`UTF-8 이 아닌 경로: ${path} — macOS 는 이 이름을 만들지 못합니다`];
  const problems = [];
  if (path !== path.normalize("NFC")) problems.push(`NFC 정규형이 아닌 경로: ${path}`);
  const unknown = [...new Set([...path].map((ch) => ch.codePointAt(0)).filter((cp) => !isAssigned(cp)))];
  if (unknown.length > 0) {
    problems.push(`macOS 가 모르는 문자가 든 경로: ${path} (${unknown.map(hex).join(", ")}) — Unicode ${UNICODE_VERSION} 에 할당된 문자만 받습니다(비문자 제외)`);
  }
  const parts = path.split("/");
  if (parts.some((part) => DOTGIT_COMPONENT.test(asGitReads(part)))) problems.push(`.git 경로 성분은 받지 않습니다: ${path}`);
  if (parts.some((part) => part === "" || part === "." || part === "..")) problems.push(`체크아웃 못 하는 경로 성분: ${path} — 빈 이름, ".", ".." 은 받지 않습니다`);
  if (parts.includes(NAMED_FORK)) problems.push(`macOS 가 리소스 포크로 읽는 경로 성분: ${path} — "${NAMED_FORK}" 은 받지 않습니다`);
  const longest = Math.max(...parts.map((part) => Buffer.byteLength(part)));
  if (longest > NAME_MAX_BYTES) problems.push(`체크아웃 못 하는 경로: ${path} — 이름 하나가 ${longest}B, ${NAME_MAX_BYTES}B 이하만 받습니다`);
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes > PATH_MAX_BYTES) problems.push(`체크아웃 못 하는 경로: ${path} — 경로가 ${pathBytes}B, ${PATH_MAX_BYTES}B 이하만 받습니다`);
  return problems;
}
