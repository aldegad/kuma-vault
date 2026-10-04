// Receive rule 2, one test per checkout-breaking axis (docs/server.md, "What a checkout can
// write"). The APFS fixture is a measurement on a Mac, so the case key is held to what APFS
// does, not to what this file assumes it does.

import { describe, expect, it } from "vitest";

import { APFS_COLLIDE, APFS_DISTINCT, APFS_REFUSED } from "./apfs-name-matching.fixture.mjs";
import { caseKey, checkoutPathProblems, decodePath, isDotGitmodules, unicodeRuntimeProblem } from "./checkout-paths.mjs";

const name = (hex) => String.fromCodePoint(...hex.split(".").map((h) => parseInt(h, 16)));
const pairs = (list) =>
  list
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("|").map(name));
const problems = (path) => checkoutPathProblems(path).join("\n");

describe("checkout paths: encoding", () => {
  it("decodes UTF-8 fatally: a stray byte, an overlong form or an encoded surrogate is not a path", () => {
    for (const bytes of [Buffer.from("caf\xe9.md", "latin1"), Buffer.from([0x61, 0xc0, 0xaf, 0x62]), Buffer.from([0x61, 0xed, 0xa0, 0x80, 0x62])]) {
      const decoded = decodePath(bytes);
      expect(decoded.utf8).toBe(false);
      expect(checkoutPathProblems(decoded.path, decoded.utf8)[0]).toContain("UTF-8 이 아닌 경로");
    }
    expect(decodePath(Buffer.from("caf\xe9.md", "latin1")).path).toBe("caf\\xe9.md");
  });

  it("keeps a leading U+FEFF as part of the name", () => {
    expect(decodePath(Buffer.from("﻿a.md")).path).toBe("﻿a.md");
  });

  it("refuses code points APFS does not know: noncharacters, unassigned and post-16.0 ones", () => {
    for (const cp of [0xfdd0, 0xfdef, 0xfffe, 0xffff, 0x1fffe, 0x10ffff, 0x0378, 0xe0080, 0xa7ce, 0x16ea0]) {
      expect(problems(`vault/a${String.fromCodePoint(cp)}b.md`), cp.toString(16)).toContain("macOS 가 모르는 문자");
    }
    for (const [a] of pairs(APFS_REFUSED)) expect(problems(a)).toContain("macOS 가 모르는 문자");
  });

  it("takes what both clients write: Unicode 16.0 additions, private use, controls, Windows-reserved names", () => {
    for (const path of ["vault/a\u{1fae9}b.md", "vault/ab.md", "vault/a\u{10fffd}b", "vault/a\x01b", "vault/a\x7fb", "vault/a\nb", "vault/a:b.md", "vault/a\\b.md", "vault/a.", "vault/a ", "vault/CON", 'vault/a<>|?*"b', "vault/-rf.md", "vault/�.md"]) {
      expect(checkoutPathProblems(path), JSON.stringify(path)).toEqual([]);
    }
  });
});

describe("checkout paths: runtime", () => {
  it("needs a runtime whose ICU knows the table's Unicode version", () => {
    for (const version of ["16.0", "16.1", "17.0", "100.0"]) expect(unicodeRuntimeProblem(version), version).toBeNull();
    for (const version of ["15.1", "15.0", "9.0", "", null]) expect(unicodeRuntimeProblem(version), String(version)).toContain("needs a Node whose ICU knows Unicode 16.0");
    expect(unicodeRuntimeProblem()).toBeNull(); // the runtime running this suite
  });
});

describe("checkout paths: normalization and case", () => {
  it("refuses NFD", () => {
    expect(problems("vault/café.md")).toContain("NFC 정규형이 아닌 경로");
  });

  it("gives one key to every pair APFS measured as one file", () => {
    const misses = pairs(APFS_COLLIDE).filter(([a, b]) => caseKey(a.normalize("NFC")) !== caseKey(b.normalize("NFC")));
    expect(misses).toEqual([]);
    expect(pairs(APFS_COLLIDE).length).toBeGreaterThan(1600);
  });

  it("keeps apart what APFS keeps apart: dotless i, ignorable code points, compatibility look-alikes", () => {
    const merged = pairs(APFS_DISTINCT).filter(([a, b]) => caseKey(a.normalize("NFC")) === caseKey(b.normalize("NFC")));
    expect(merged).toEqual([]);
  });

  it("folds the pairs a lower-case compare misses, and NFC against NFD", () => {
    for (const [a, b] of [["ß.md", "ss.md"], ["ẞ.md", "SS.md"], ["ς.md", "σ.md"], ["ﬀ.md", "FF.md"], ["K", "k"], ["Å", "å"], ["café", "café"], ["Vault/X", "vault/x"]]) {
      expect(caseKey(a), `${a} ${b}`).toBe(caseKey(b));
    }
  });
});

describe("checkout paths: components and length", () => {
  it("refuses empty, . and .. components and .git in any spelling NTFS or case folds to it", () => {
    for (const path of ["vault//a.md", "vault/./a.md", "vault/../a.md", "vault/.", "vault/..", "/a.md", "vault/"]) {
      expect(problems(path), path).toContain("체크아웃 못 하는 경로 성분");
    }
    for (const path of ["vault/.git/config", "vault/.GIT/config", "vault/.git./config", "vault/.git /x", "vault/git~1/config"]) {
      expect(problems(path), path).toContain(".git 경로 성분");
    }
    expect(problems("vault/.g\u200cit/config")).toContain(".git 경로 성분"); // git on macOS reads it as .git
    expect(problems("vault/\ufeff.Git\u200d/config")).toContain(".git 경로 성분");
    expect(checkoutPathProblems("vault/...")).toEqual([]);
    expect(checkoutPathProblems("vault/.gitignore")).toEqual([]);
  });

  it("refuses a ..namedfork component, which macOS reads as a resource fork", () => {
    for (const path of ["vault/..namedfork/rsrc", "vault/d/..namedfork/rsrc", "vault/..namedfork/rsrc/x.md", "..namedfork/rsrc", "vault/..namedfork/data", "vault/..namedfork"]) {
      expect(problems(path), path).toContain("macOS 가 리소스 포크로 읽는 경로 성분");
    }
    // the kernel compares the bytes: other spellings are ordinary names on a Mac
    for (const path of ["vault/..NAMEDFORK/rsrc", "vault/..namedfork.md", "vault/..named\u200cfork/rsrc", "vault/.namedfork/rsrc", "vault/rsrc"]) {
      expect(checkoutPathProblems(path), path).toEqual([]);
    }
  });

  it("knows a .gitmodules in any case or HFS spelling (a symlink there is never checked out)", () => {
    for (const path of [".gitmodules", "vault/.GitModules", "vault/.git\u200cmodules"]) expect(isDotGitmodules(path), path).toBe(true);
    for (const path of ["vault/.gitmodules.md", "vault/.gitmodules/x", "vault/gitmodules"]) expect(isDotGitmodules(path), path).toBe(false);
  });

  it("counts lengths in bytes of the NFC path", () => {
    expect(checkoutPathProblems(`vault/${"한".repeat(85)}`)).toEqual([]);
    expect(problems(`vault/${"한".repeat(86)}`)).toContain("이름 하나가 258B");
    expect(problems(`${"d".repeat(200)}/`.repeat(4) + "x")).toContain("경로가 805B");
  });
});
