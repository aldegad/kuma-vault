import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createIdentifier } from "./auth.mjs";
import { compileGitignore } from "./gitignore-match.mjs";
import { LFS_EXTENSIONS, isLfsPath, parseLfsPointer, renderLfsGitattributesLines, renderLfsPointer } from "./lfs-paths.mjs";
import { findToken, hashToken, normalizeServerConfig, storeRole, ROLE_LEVEL } from "./server-config.mjs";
import { readRejectList } from "./server-cli.mjs";
import { externalOrigin } from "./serve.mjs";

const OID = "a".repeat(64);

describe("lfs paths", () => {
  it("compares extensions lower-case and keeps the 64-entry list", () => {
    expect(LFS_EXTENSIONS).toHaveLength(64);
    expect(isLfsPath("vault/a/B.PNG")).toBe(true);
    expect(isLfsPath("vault/x.Blend1")).toBe(true);
    expect(isLfsPath("vault/x.md")).toBe(false);
    expect(isLfsPath("vault/png")).toBe(false);
  });

  it("routes 3D outputs, print jobs, audio, images and office files to LFS, text 3D formats included", () => {
    const added = ["ply", "stl", "3mf", "obj", "gcode", "bgcode", "step", "stp", "model", "fbx", "gltf", "vdb", "exr", "tif", "tiff", "flac", "aif", "aiff", "bmp", "doc", "hwpx", "odp", "wasm"];
    for (const ext of added) {
      expect(isLfsPath(`vault/out/part.${ext}`), ext).toBe(true);
      expect(isLfsPath(`vault/out/PART.${ext.toUpperCase()}`), ext).toBe(true);
    }
    expect(isLfsPath("vault/out/slice.gcode.md")).toBe(false); // a text sidecar stays text
    expect(renderLfsGitattributesLines()).toContain("*.3[mM][fF] filter=lfs diff=lfs merge=lfs -text");
  });

  it("is the same ordered list the history rewrite tools read", () => {
    const tools = JSON.parse(readFileSync(new URL("../../scripts/brain-rewrite/lfs-extensions.json", import.meta.url), "utf8"));
    expect(tools.extensions).toEqual([...LFS_EXTENSIONS]);
  });

  it("renders case-insensitive gitattributes patterns", () => {
    expect(renderLfsGitattributesLines()).toContain("*.[pP][nN][gG] filter=lfs diff=lfs merge=lfs -text");
    expect(renderLfsGitattributesLines()).toContain("*.7[zZ] filter=lfs diff=lfs merge=lfs -text");
  });

  it("accepts only canonical pointers", () => {
    expect(parseLfsPointer(Buffer.from(renderLfsPointer(OID, 12)))).toEqual({ oid: OID, size: 12 });
    expect(parseLfsPointer(Buffer.from(renderLfsPointer(OID, 12).replace(/\n/g, "\r\n")))).toBeNull();
    expect(parseLfsPointer(Buffer.from(`${renderLfsPointer(OID, 12)}extra`))).toBeNull();
    expect(parseLfsPointer(Buffer.from(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${OID}\noid sha256:${OID}\nsize 1\n`))).toBeNull();
    expect(parseLfsPointer(Buffer.from(renderLfsPointer(OID.toUpperCase(), 1)))).toBeNull();
    expect(parseLfsPointer(Buffer.from(""))).toBeNull();
  });
});

describe("gitignore matcher", () => {
  const match = compileGitignore(["vault/_work/", "*.commit-lock", ".fts/", "renders/**/tmp", "/top.txt"], { ignoreCase: true });

  it("anchors patterns with a slash and floats bare names", () => {
    expect(match("vault/_work/a.png")).toBe("vault/_work/");
    expect(match("vault/_WORK/deep/a.png")).toBe("vault/_work/");
    expect(match("other/vault/_work/a.png")).toBeNull();
    expect(match("a/b/x.commit-lock")).toBe("*.commit-lock");
    expect(match("vault/.fts/vault-fts.db")).toBe(".fts/");
    expect(match("vault/.fts")).toBeNull(); // dir-only pattern does not match a file
    expect(match("renders/a/b/tmp")).toBe("renders/**/tmp");
    expect(match("top.txt")).toBe("/top.txt");
    expect(match("x/top.txt")).toBeNull();
  });

  it("refuses negation", () => {
    expect(() => compileGitignore(["!keep"])).toThrow(/negation/);
  });
});

describe("server.json", () => {
  const base = { version: 1, listen: ["127.0.0.1:7741"], dataDir: "/data/vaults", stores: { s: { owners: ["me@example.com"], writers: ["w@example.com"], readers: ["node:ci-box"] } } };

  it("fills defaults and rejects unknown keys", () => {
    const config = normalizeServerConfig(base);
    expect(config.stores.s.path).toBe("/data/vaults/s");
    expect(config.diskReserveGB).toBe(8);
    expect(config.maxNonLfsBlobBytes).toBe(32 * 1024 * 1024);
    expect(() => normalizeServerConfig({ ...base, listne: [] })).toThrow(/unknown key "listne"/);
    expect(() => normalizeServerConfig({ ...base, stores: { s: { owner: [] } } })).toThrow(/unknown key "owner"/);
    expect(() => normalizeServerConfig({ ...base, stores: { "Bad.git": {} } })).toThrow(/store id/);
  });

  it("resolves roles for logins, tagged nodes and tokens", () => {
    const config = normalizeServerConfig({ ...base, tokens: [{ id: "t1", sha256: hashToken("secret"), role: "writer", stores: ["s"] }] });
    expect(storeRole(config, "s", { kind: "user", login: "me@example.com" })).toBe(ROLE_LEVEL.owner);
    expect(storeRole(config, "s", { kind: "user", login: "w@example.com" })).toBe(ROLE_LEVEL.writer);
    expect(storeRole(config, "s", { kind: "node", name: "ci-box" })).toBe(ROLE_LEVEL.reader);
    expect(storeRole(config, "s", { kind: "user", login: "stranger@example.com" })).toBe(ROLE_LEVEL.none);
    const token = findToken(config, "secret");
    expect(token.id).toBe("t1");
    expect(findToken(config, "nope")).toBeNull();
    expect(storeRole(config, "s", { kind: "token", token })).toBe(ROLE_LEVEL.writer);
  });

  it("reads a reject-list file in all accepted shapes", () => {
    expect(readRejectList('["a/"]')).toEqual(["a/"]);
    expect(readRejectList('{"reject":["b/"]}')).toEqual(["b/"]);
    expect(readRejectList('{"binaries":{"reject":["c/"]}}')).toEqual(["c/"]);
    expect(() => readRejectList('{"x":1}')).toThrow(/reject file/);
  });
});

describe("identity", () => {
  const config = normalizeServerConfig({
    version: 1,
    listen: ["127.0.0.1:7741"],
    auth: { selfAddresses: ["100.64.0.1"] },
    tokens: [{ id: "t", sha256: hashToken("tok"), role: "reader", stores: ["*"] }],
    stores: {},
  });
  const whoisTable = {
    "100.64.0.5": { stableId: "peer1", nodeName: "mac", tagged: false, login: "me@example.com" },
    "100.64.0.6": { stableId: "peer2", nodeName: "ci-box", tagged: true, login: "tagged-devices" },
    "100.64.0.7": { stableId: "SELF", nodeName: "brain-server", tagged: false, login: "me@example.com" },
  };
  let whoisCalls = 0;
  const identify = createIdentifier(config, {
    whois: async (ip) => {
      whoisCalls += 1;
      return whoisTable[ip] ?? null;
    },
    selfStableId: "SELF",
    interfaceAddresses: () => new Set(["10.1.2.3"]),
  });
  const req = (ip, authorization) => ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: ip, remotePort: 5555 } });

  it("identifies tailnet peers by whois and caches the answer", async () => {
    expect((await identify(req("100.64.0.5"))).principal).toMatchObject({ kind: "user", login: "me@example.com" });
    const before = whoisCalls;
    await identify(req("::ffff:100.64.0.5"));
    expect(whoisCalls).toBe(before);
    expect((await identify(req("100.64.0.6"))).principal).toMatchObject({ kind: "node", name: "ci-box" });
  });

  it("never lets the server itself borrow the owner's whois identity", async () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "10.1.2.3", "100.64.0.7"]) {
      const who = await identify(req(ip));
      expect(who.principal, ip).toBeNull();
    }
  });

  it("never reads X-Forwarded-* — the socket address and the token decide", async () => {
    const forged = (ip) => ({ ...req(ip), headers: { "x-forwarded-for": "100.64.0.5", "x-forwarded-host": "vault.example.org", "x-forwarded-proto": "https" } });
    expect((await identify(forged("127.0.0.1"))).principal).toBeNull();
    expect((await identify(forged("100.64.0.6"))).principal).toMatchObject({ kind: "node", name: "ci-box" });
  });

  it("takes bearer or basic tokens and refuses unknown ones", async () => {
    expect((await identify(req("127.0.0.1", "Bearer tok"))).principal.kind).toBe("token");
    expect((await identify(req("127.0.0.1", `Basic ${Buffer.from("x:tok").toString("base64")}`))).principal.kind).toBe("token");
    const bad = await identify(req("100.64.0.5", "Bearer wrong"));
    expect(bad.principal).toBeNull();
    expect(bad.invalidToken).toBe(true);
  });
});

describe("LFS href origin", () => {
  const req = (ip, headers) => ({ headers: { host: "127.0.0.1:7741", ...headers }, socket: { remoteAddress: ip } });
  const proxy = { "x-forwarded-proto": "https", "x-forwarded-host": "vault.example.org" };

  it("takes X-Forwarded-Proto / -Host from loopback only", () => {
    for (const ip of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"]) expect(externalOrigin(req(ip, proxy)), ip).toBe("https://vault.example.org");
    for (const ip of ["100.64.0.5", "10.1.2.3", "::ffff:100.64.0.5", "fd7a:115c::5"]) expect(externalOrigin(req(ip, proxy)), ip).toBe("http://127.0.0.1:7741");
  });

  it("keeps Host when only the scheme is forwarded, and the first value of a list", () => {
    expect(externalOrigin(req("127.0.0.1", { "x-forwarded-proto": "https" }))).toBe("https://127.0.0.1:7741");
    expect(externalOrigin(req("127.0.0.1", { "x-forwarded-proto": " Https ,http", "x-forwarded-host": "[fd7a::1]:443, b" }))).toBe("https://[fd7a::1]:443");
  });

  it("refuses a scheme or host that is not one, from loopback; from elsewhere judges Host alone", () => {
    for (const headers of [{ "x-forwarded-proto": "ftp" }, { "x-forwarded-host": "a.example/b" }, { "x-forwarded-host": "u@a.example" }, { "x-forwarded-host": "a.example:x" }]) {
      expect(() => externalOrigin(req("127.0.0.1", headers)), JSON.stringify(headers)).toThrow(/X-Forwarded-Proto|Host/);
    }
    expect(externalOrigin(req("100.64.0.5", { "x-forwarded-host": "a.example/b" }))).toBe("http://127.0.0.1:7741");
    expect(() => externalOrigin(req("100.64.0.5", { host: "evil.example/x#" }))).toThrow(/Host/);
    expect(() => externalOrigin({ headers: {}, socket: { remoteAddress: "100.64.0.5" } })).toThrow(/Host/);
  });
});
