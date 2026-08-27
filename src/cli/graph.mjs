// `vault graph` — render the vault topology as an interactive node-link graph.
//
// Walks the vault, builds one edge set per frontmatter CONNECTION METHODOLOGY (the vault's
// canonical linking contract, schema.md), and emits ONE self-contained HTML (no external
// deps): a canvas force graph rooted at the vault (kuma-brain), with each methodology as a
// toggleable/solo-able classified layer. Every layer ships its own WHY + ROLE explanation so
// the GUI documents *why each classification exists and what it does*.
//
// Layers (each = a distinct way the frontmatter connects knowledge):
//   hier      folder README topology (containment backbone)
//   ref       explicit cross-reference: `related:` / `## Related` / md-link / wikilink
//   alias     reference resolved via a page `aliases` value (search-handle, near-empty by design)
//   tag       shared `tags` → tag hubs
//   domain    `domain:` (DEPRECATED field, 2026-07-05) → drift hubs; empty after migration
//   schema    `type:` / `kind:` schema field → type hubs
//   project   `project:` field → project hubs
//   planline  `parent_plan:` chain (plan lineage)
//   xstore    cross-store pointer `<store-id>:<path>` → documents in ANOTHER registered
//             knowledge tree (vault-stores.json registry; parser shared with vault lint)
//
// `--all-stores` renders the UNION view: every registered, scannable store is walked as its
// own rooted component, and cross-store pointers resolve to the target store's REAL document
// nodes — so the picture answers "can an agent traverse from one store into the other, and
// through how many bridges" with only edges an agent can actually follow. No synthetic
// connections are added: unconnected stores render as separate components, which is the truth.
//
// This is a machine-only derived artifact (like `.fts/`): default output is
// `<vault>/.graph/topology.html` (`union.html` for --all-stores), a self-ignoring dot-dir
// regenerable from the leaf markdown.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, relative, basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { readOptionalString } from "./cli-options.mjs";
import { resolveVaultDir } from "../index.mjs";
import { extractCrossStorePointers } from "../engine/vault-lint.mjs";
import { loadStoreRegistry } from "../engine/vault-stores.mjs";

const SKIP_DIRS = new Set([".git", ".fts", ".graph", "node_modules", ".obsidian"]);
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|pdf|mp4|mov|webm|mp3|wav|zip|dot|css|js|html?)$/i;

function normPosix(p) {
  const out = [];
  for (const s of p.replace(/\\/g, "/").split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else out.push(".."); }
    else out.push(s);
  }
  return out.join("/");
}
const topSection = (rel) => (rel.includes("/") ? rel.split("/")[0] : "(root)");

function fmBlock(t) { if (!t.startsWith("---")) return null; const e = t.indexOf("\n---", 3); return e < 0 ? null : t.slice(3, e); }
function fmField(block, key) {
  const lines = block.split("\n"), vals = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(new RegExp("^" + key + ":\\s*(.*)$"));
    if (!m) continue;
    const inl = m[1].trim();
    if (inl.startsWith("[")) inl.replace(/^\[|\]$/g, "").split(",").forEach((v) => { const s = v.trim().replace(/^["']|["']$/g, ""); if (s) vals.push(s); });
    else if (inl) vals.push(inl.replace(/^["']|["']$/g, ""));
    for (let j = i + 1; j < lines.length; j += 1) {
      const li = lines[j].match(/^\s*-\s+(.+?)\s*(?:#.*)?$/);
      if (li) vals.push(li[1].trim().replace(/^["']|["']$/g, ""));
      else if (/^\S/.test(lines[j]) || /^\s*[a-z_]+:/i.test(lines[j])) break;
    }
  }
  return vals;
}
function fmScalar(block, key) { const m = block.match(new RegExp("^" + key + ":\\s*(.+?)\\s*$", "m")); return m ? m[1].replace(/^["']|["']$/g, "").trim() : null; }

// ---- per-store scan: one tree → nodes + every within-tree layer ----
// All node/edge semantics are PER STORE (relative links, plan ids, tag vocab, and search all
// operate within one tree), so the union view is "more scans", never merged semantics. Only
// the cross-store pointer layer, resolved by the caller, is allowed to connect scans.
function scanStore(nodes, addNode, { root, storeId, idPrefix, secPrefix }) {
  const folderList = [], docFiles = [];
  (function walk(dir) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; folderList.push(relative(root, join(dir, e.name)).replace(/\\/g, "/")); walk(join(dir, e.name)); }
      else if (e.isFile() && e.name.endsWith(".md")) docFiles.push({ full: join(dir, e.name), rel: relative(root, join(dir, e.name)).replace(/\\/g, "/") });
    }
  })(root);
  folderList.sort();

  const ROOT = addNode("«root»" + (idPrefix ? ":" + storeId : ""), "root", storeId, secPrefix + "(root)");
  const folderIdx = new Map(); folderIdx.set("", ROOT);
  for (const rel of folderList) folderIdx.set(rel, addNode("dir:" + idPrefix + rel, "folder", rel.split("/").pop(), secPrefix + topSection(rel)));

  const byPath = new Map(), byPathNoExt = new Map(), byStem = new Map(), byAlias = new Map();
  const docNodeIdx = new Map(), docMeta = [];
  for (const { full, rel } of docFiles) {
    let text = ""; try { text = readFileSync(full, "utf8"); } catch { /* unreadable → skip body */ }
    if (text.length > 120000) text = text.slice(0, 120000);
    const fm = fmBlock(text) || "";
    let title = fmScalar(fm, "title"); if (!title) { const h = text.match(/^#\s+(.+)$/m); if (h) title = h[1].trim(); } if (!title) title = basename(rel, ".md");
    const idx = addNode("doc:" + idPrefix + rel, "doc", title, secPrefix + topSection(rel));
    docNodeIdx.set(rel, idx);
    byPath.set(rel, idx); byPath.set(rel.toLowerCase(), idx);
    const noext = rel.replace(/\.md$/, ""); byPathNoExt.set(noext, idx); byPathNoExt.set(noext.toLowerCase(), idx);
    const stem = basename(rel, ".md").toLowerCase(); if (!byStem.has(stem)) byStem.set(stem, []); byStem.get(stem).push(idx);
    const aliases = fm ? fmField(fm, "aliases") : [];
    for (const a of aliases) { const k = a.toLowerCase(); if (!byAlias.has(k)) byAlias.set(k, idx); }
    const targets = [];
    if (fm) for (const key of ["related", "see_also", "related_pages"]) for (const v of fmField(fm, key)) targets.push(v);
    const body = fm ? text.slice(fm.length + 6) : text;
    for (const m of body.matchAll(/\]\(([^)\s]+?)(?:#[^)]*)?\)/g)) targets.push(m[1]);
    for (const m of body.matchAll(/\[\[([^\]\n|#]+)(?:[|#][^\]\n]*)?\]\]/g)) targets.push(m[1]);
    docMeta.push({
      idx, rel, dir: dirname(rel), targets,
      tags: fm ? fmField(fm, "tags").map((t) => t.trim()).filter(Boolean) : [],
      domain: fm ? fmScalar(fm, "domain") : null,
      type: fm ? fmScalar(fm, "type") : null,
      kind: fm ? fmScalar(fm, "kind") : null,
      project: fm ? fmScalar(fm, "project") : null,
      parentPlan: fm ? fmScalar(fm, "parent_plan") : null,
      xrefs: extractCrossStorePointers(text),
    });
  }

  const AMBIG = new Set(["readme", "index", "notes", "log"]);
  function resolveRef(raw, fromDir) {
    if (!raw) return { idx: -1 };
    let t = raw.trim().replace(/^<|>$/g, "").replace(/^["'`]|["'`]$/g, "").split("#")[0].split("|")[0].trim();
    if (!t || /^(https?:|mailto:|tel:|#|data:)/i.test(t) || SKIP_EXT.test(t)) return { idx: -1 };
    if (t.includes("/") || /\.md$/i.test(t)) {
      const bases = t.startsWith("/") ? [t.slice(1)] : [fromDir ? fromDir + "/" + t : t, t];
      for (let c of bases) {
        c = normPosix(c); const md = /\.md$/i.test(c) ? c : c + ".md";
        for (const cand of [c, c.toLowerCase(), md, md.toLowerCase()]) if (byPath.has(cand)) return { idx: byPath.get(cand), method: "path" };
        for (const cand of [c, c.toLowerCase()]) if (byPathNoExt.has(cand)) return { idx: byPathNoExt.get(cand), method: "path" };
      }
      return { idx: -1 };
    }
    const low = t.toLowerCase();
    if (byAlias.has(low)) return { idx: byAlias.get(low), method: "alias" };
    const stem = low.replace(/\.md$/, "");
    if (byStem.has(stem) && byStem.get(stem).length === 1 && !AMBIG.has(stem)) return { idx: byStem.get(stem)[0], method: "stem" };
    return { idx: -1 };
  }

  const refSet = new Set(), aliasSet = new Set(), refEdges = [], aliasEdges = [];
  let refUnresolved = 0;
  for (const { idx, targets, dir } of docMeta) for (const raw of targets) {
    const { idx: to, method } = resolveRef(raw, dir);
    if (to < 0) { refUnresolved += 1; continue; } if (to === idx) continue;
    const a = Math.min(idx, to), b = Math.max(idx, to), k = a + "|" + b;
    if (method === "alias") { if (!aliasSet.has(k)) { aliasSet.add(k); aliasEdges.push([a, b]); } }
    else if (!refSet.has(k)) { refSet.add(k); refEdges.push([a, b]); }
  }

  const hierEdges = [];
  for (const rel of folderList) hierEdges.push([folderIdx.get(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""), folderIdx.get(rel)]);
  for (const { rel } of docFiles) hierEdges.push([folderIdx.get(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""), docNodeIdx.get(rel)]);

  function hubLayer(groupFn, prefix, type, sharedOnly) {
    const map = new Map();
    for (const m of docMeta) { for (const key of groupFn(m)) { if (!key) continue; if (!map.has(key)) map.set(key, []); map.get(key).push(m.idx); } }
    const edges = []; let hubs = 0;
    for (const [key, docs] of [...map.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const uniq = [...new Set(docs)]; if (sharedOnly && uniq.length < 2) continue;
      const hi = addNode(prefix + idPrefix + key, type, (type === "tag" ? "#" : "") + key, "«" + type + "»"); hubs += 1;
      for (const d of uniq) edges.push([hi, d]);
    }
    return { edges, hubs };
  }
  const tag = hubLayer((m) => m.tags.map((t) => (t && t.length <= 40 ? t : null)), "tag:", "tag", true);
  const domain = hubLayer((m) => [m.domain], "dom:", "domain", false);
  const schema = hubLayer((m) => [m.type || (m.kind ? "kind:" + m.kind : null)], "sch:", "schema", false);
  const project = hubLayer((m) => [m.project], "prj:", "project", false);

  function resolvePlan(v) {
    if (!v) return -1;
    let s = v.trim().replace(/^["']|["']$/g, "");
    const abs = s.match(/\.kuma\/plans\/(.+)$/); if (abs) s = abs[1];
    s = normPosix(s.replace(/\.md$/, "")) + ".md";
    const cand = "plans/" + s;
    if (byPath.has(cand)) return byPath.get(cand);
    if (byPath.has(cand.toLowerCase())) return byPath.get(cand.toLowerCase());
    const stem = basename(s, ".md").toLowerCase();
    if (byStem.has(stem) && byStem.get(stem).length === 1) return byStem.get(stem)[0];
    return -1;
  }
  const planSet = new Set(), planEdges = []; let planUnresolved = 0;
  for (const m of docMeta) {
    if (!m.parentPlan) continue;
    const to = resolvePlan(m.parentPlan);
    if (to < 0 || to === m.idx) { if (to < 0) planUnresolved += 1; continue; }
    const a = Math.min(m.idx, to), b = Math.max(m.idx, to), k = a + "|" + b;
    if (!planSet.has(k)) { planSet.add(k); planEdges.push([a, b]); }
  }

  function buildTree() {
    const root = { name: storeId, children: new Map(), docs: [] };
    for (const { rel } of docFiles) {
      const parts = rel.split("/"); let cur = root;
      for (let i = 0; i < parts.length - 1; i += 1) { const s = parts[i]; if (!cur.children.has(s)) cur.children.set(s, { name: s, children: new Map(), docs: [] }); cur = cur.children.get(s); }
      cur.docs.push({ name: parts[parts.length - 1], title: nodes[docNodeIdx.get(rel)].title, idx: docNodeIdx.get(rel) });
    }
    function conv(n) { const folders = [...n.children.values()].map(conv).sort((a, b) => a.name.localeCompare(b.name)); const docs = n.docs.sort((a, b) => a.name.localeCompare(b.name)); let c = docs.length; for (const f of folders) c += f.count; return { name: n.name, folders, docs, count: c }; }
    return [...root.children.values()].map(conv).sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    storeId, root, rootIdx: ROOT, folderIdx, byPath, byPathNoExt, docMeta,
    docs: docFiles.length, folders: folderList.length,
    edges: { hier: hierEdges, ref: refEdges, alias: aliasEdges, tag: tag.edges, domain: domain.edges, schema: schema.edges, project: project.edges, planline: planEdges },
    hubs: { tag: tag.hubs, domain: domain.hubs, schema: schema.hubs, project: project.hubs },
    refUnresolved, planUnresolved, tree: buildTree(),
  };
}

// ---- build the graph model: one scan per store, cross-store pointers connecting them ----
export function buildGraphData(VAULT, { env = process.env, allStores = false } = {}) {
  const registry = loadStoreRegistry(env);
  const registryOk = registry.present && !registry.invalid;
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const vaultReal = real(VAULT);

  // The primary tree's store identity self-heals from the registry when it is registered
  // (원칙 1: the id is owned by the tree/registry pair, not by a basename guess).
  let primaryId = null;
  if (registryOk) for (const [id, e] of registry.stores) { if (e.status === "ok" && real(e.rootDir) === vaultReal) { primaryId = id; break; } }
  if (!primaryId) primaryId = basename(VAULT) === "vault" ? "kuma-brain" : basename(VAULT);

  // Union mode is an explicit ask; without a registry there is nothing true to union over,
  // and inventing a store list would be a silent fallback (원칙 6).
  if (allStores && !registryOk) {
    throw new Error(`--all-stores requires a valid store registry: ${registry.invalid ? `${registry.path} is invalid (${registry.invalid})` : `none at ${registry.path}`}`);
  }

  const storeSpecs = [{ storeId: primaryId, root: VAULT, primary: true }];
  if (allStores) {
    for (const [id, e] of registry.stores) {
      if (e.status !== "ok") continue; // not scannable on this machine → pointers to it stay phantom externals
      if (real(e.rootDir) === vaultReal) continue; // that IS the primary
      storeSpecs.push({ storeId: id, root: e.rootDir, primary: false });
    }
  }
  const union = storeSpecs.length > 1;

  const nodes = [];
  const addNode = (id, type, title, sec) => { const i = nodes.length; nodes.push({ id, type, title, sec }); return i; };
  // Every node carries its store index (`st`) so the renderer can give each store its own
  // gravity anchor — separation on screen then MEANS "not connected", instead of every
  // component being pulled onto one shared center regardless of connectivity.
  const scans = storeSpecs.map((s, si) => {
    const start = nodes.length;
    const sc = scanStore(nodes, addNode, {
      root: s.root, storeId: s.storeId,
      idPrefix: union ? s.storeId + ":" : "",
      secPrefix: union && !s.primary ? s.storeId + ":" : "",
    });
    for (let j = start; j < nodes.length; j += 1) nodes[j].st = si;
    return sc;
  });
  const scanByRoot = new Map(scans.map((sc) => [real(sc.root), sc]));

  // Cross-store layer. The registry gate is the correctness boundary (원칙 6): with no
  // registry this machine has not opted in, so the layer is empty and the skip is REPORTED
  // (stdout), never silently passed. A pointer naming an unregistered store is counted, not
  // drawn — the lint owns failing it loud. A pointer into a SCANNED store resolves to that
  // store's real node (one document, one node — this is what makes the union view an actual
  // traversal graph, not two pictures glued together); only a registered-but-unscanned store
  // gets a phantom hub + external-doc nodes.
  const xstoreHubIdx = new Map(), xdocIdx = new Map(), xstoreSet = new Set(), xstoreEdges = [];
  let xstoreUnknown = 0, xstoreUnresolved = 0, xstoreBridges = 0;
  const xstoreEnabled = registryOk;
  if (xstoreEnabled) {
    const pushEdge = (a0, b0) => { const a = Math.min(a0, b0), b = Math.max(a0, b0), k = a + "|" + b; if (xstoreSet.has(k)) return false; xstoreSet.add(k); xstoreEdges.push([a, b]); return true; };
    for (let si = 0; si < scans.length; si += 1) { const scan = scans[si];
    for (const m of scan.docMeta) for (const { storeId, targetPath } of m.xrefs) {
      const entry = registry.stores.get(storeId);
      if (!entry) { xstoreUnknown += 1; continue; }
      const clean = targetPath.replace(/\/+$/, "");
      const targetScan = entry.status === "ok" ? scanByRoot.get(real(entry.rootDir)) : undefined;
      if (targetScan) {
        const to = targetPath.endsWith("/")
          ? (targetScan.folderIdx.has(clean) ? targetScan.folderIdx.get(clean) : -1)
          : (targetScan.byPath.get(clean) ?? targetScan.byPathNoExt.get(clean.replace(/\.md$/, "")) ?? -1);
        if (to < 0) { xstoreUnresolved += 1; continue; }
        if (to !== m.idx && pushEdge(m.idx, to) && targetScan !== scan) xstoreBridges += 1;
        continue;
      }
      if (!xstoreHubIdx.has(storeId)) { const hi = addNode("xst:" + storeId, "xstore", storeId, "«xstore»"); nodes[hi].st = si; xstoreHubIdx.set(storeId, hi); }
      const key = storeId + ":" + targetPath;
      if (!xdocIdx.has(key)) {
        const di = addNode("xdoc:" + key, "xdoc", basename(clean) || targetPath, storeId);
        nodes[di].st = si;
        xdocIdx.set(key, di);
        xstoreEdges.push([xstoreHubIdx.get(storeId), di]);
      }
      pushEdge(m.idx, xdocIdx.get(key));
    } }
  }

  const layers = { hier: [], ref: [], xstore: xstoreEdges, alias: [], tag: [], domain: [], schema: [], project: [], planline: [] };
  for (const sc of scans) for (const [key, E] of Object.entries(sc.edges)) layers[key].push(...E);
  const deg = new Array(nodes.length).fill(0);
  for (const E of Object.values(layers)) for (const [a, b] of E) { deg[a] += 1; deg[b] += 1; }
  nodes.forEach((n, i) => { n.deg = deg[i]; });
  const sectionCounts = {};
  for (const n of nodes) if (n.type === "folder" || n.type === "doc") sectionCounts[n.sec] = (sectionCounts[n.sec] || 0) + 1;

  const sum = (fn) => scans.reduce((t, sc) => t + fn(sc), 0);
  const counts = {
    docs: sum((sc) => sc.docs), folders: sum((sc) => sc.folders),
    hier: layers.hier.length, ref: layers.ref.length, alias: layers.alias.length, tag: layers.tag.length,
    domain: layers.domain.length, schema: layers.schema.length, project: layers.project.length, planline: layers.planline.length,
    xstore: xstoreEdges.length, xstoreHubs: xstoreHubIdx.size, xstoreDocs: xdocIdx.size, xstoreUnknown, xstoreUnresolved, xstoreBridges,
    tagHubs: sum((sc) => sc.hubs.tag), domainHubs: sum((sc) => sc.hubs.domain), schemaHubs: sum((sc) => sc.hubs.schema), projectHubs: sum((sc) => sc.hubs.project),
    refUnresolved: sum((sc) => sc.refUnresolved), planUnresolved: sum((sc) => sc.planUnresolved),
  };
  const tree = union
    ? scans.map((sc) => ({ name: sc.storeId, folders: sc.tree, docs: [], count: sc.docs }))
    : scans[0].tree;
  return {
    vault: VAULT, rootName: primaryId, rootIdx: scans[0].rootIdx, rootIdxs: scans.map((sc) => sc.rootIdx),
    union, stores: scans.map((sc) => ({ storeId: sc.storeId, docs: sc.docs, folders: sc.folders })),
    counts, sectionCounts, nodes, layers,
    xstoreEnabled, xstoreSkipReason: xstoreEnabled ? null : (registry.invalid ? `registry invalid: ${registry.invalid}` : `no store registry at ${registry.path}`),
    tree,
  };
}

// ---- CLI command ----
export async function commandVaultGraph(options = {}) {
  const vaultDir = readOptionalString(options, "vault-dir") ?? resolveVaultDir();
  const allStores = options["all-stores"] === true;
  const outArg = readOptionalString(options, "out");
  const out = outArg ? resolve(outArg) : join(vaultDir, ".graph", allStores ? "union.html" : "topology.html");
  const data = buildGraphData(vaultDir, { allStores });
  const html = renderHtml(data);
  const outDir = dirname(out);
  mkdirSync(outDir, { recursive: true });
  // Self-ignoring machine-artifact dir (mirrors the `.fts/` precedent): the render is a pure
  // function of the leaf markdown and must never be committed.
  if (basename(outDir) === ".graph") { try { writeFileSync(join(outDir, ".gitignore"), "*\n"); } catch { /* best effort */ } }
  writeFileSync(out, html);
  const c = data.counts;
  process.stdout.write(`vault graph -> ${out}\n`);
  if (data.union) {
    process.stdout.write(`stores: ${data.stores.map((s) => `${s.storeId}(${s.docs} docs)`).join(" · ")}\n`);
    // The union view's whole point in one number: how many real document-to-document edges
    // actually cross a store boundary. 0 = the trees are not navigably connected.
    process.stdout.write(`cross-store bridges: ${c.xstoreBridges}\n`);
  }
  process.stdout.write(`nodes=${data.nodes.length} (roots+folders ${c.folders + data.rootIdxs.length} + docs ${c.docs} + hubs ${c.tagHubs + c.domainHubs + c.schemaHubs + c.projectHubs} + xstore ${c.xstoreHubs + c.xstoreDocs})\n`);
  process.stdout.write(`layers: hier=${c.hier} ref=${c.ref} xstore=${c.xstore} alias=${c.alias} tag=${c.tag} domain=${c.domain} schema=${c.schema} project=${c.project} planline=${c.planline}\n`);
  // Not silently dropped: a reference the graph could not resolve is absent from the picture,
  // so its count must be visible where the picture is announced.
  process.stdout.write(`unresolved: ref=${c.refUnresolved} plan=${c.planUnresolved}${data.xstoreEnabled ? ` xstore-unknown-store=${c.xstoreUnknown} xstore-target=${c.xstoreUnresolved}` : ""}\n`);
  if (!data.xstoreEnabled) process.stdout.write(`xstore layer skipped: ${data.xstoreSkipReason}\n`);
  if (options.open) openInBrowser(out);
  return out;
}

function openInBrowser(file) {
  const url = "file://" + file;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* headless: skip */ }
}

// ---- HTML render (self-contained, no deps) ----
// Layer metadata: label + color + physics params + WHY (why this connection method exists,
// grounded in schema.md) + ROLE (what it does in the vault). Shown in the GUI info accordion.
const LAYER_META = [
  { key: "hier", label: "계층 (폴더 트리)", color: "#b9b9c6", rest: 30, k: 0.06, on: true,
    why: "vault의 canonical 소유 구조는 폴더 README 트리다 (architecture.md = Kuma Topology Vault). 모든 지식은 정확히 한 폴더가 소유한다.",
    role: "이 문서가 '어디 사는가'의 SSoT. 루트(kuma-brain)에서 모든 문서까지 도달하는 뼈대." },
  { key: "ref", label: "참조 (related · 링크)", color: "#e0812f", rest: 64, k: 0.035, on: true,
    why: "문서가 서로를 명시적으로 가리키는 손수 연결 (`related:`, `## Related`, 본문 상대 `.md` 링크, wikilink).",
    role: "'이거 보면 저것도 봐라' 식 사람이 의도한 cross-reference. 관련 지식 탐색." },
  { key: "xstore", label: "외부 저장소 (cross-store)", color: "#d04f4f", rest: 72, k: 0.035, w: 2.6, on: true,
    why: "cross-store 포인터 `<store-id>:<경로>` — 이 vault 가 다른 지식 트리(예: acme-ops)의 문서를 truth 로 지목하는 인라인 코드 관례 (schema.md). store-id→루트 매핑은 머신-로컬 vault-stores.json 레지스트리.",
    role: "두 저장소가 어디서 이어지는지. --all-stores union 뷰에선 스캔된 store 의 실제 문서 노드로 직접 잇는 다리(bridge)가 되고, 스캔 안 된 store 만 외부 허브+문서 노드로 남는다. 레지스트리 없는 머신에선 비어 있다(생성 시 stdout 에 skip 보고)." },
  { key: "alias", label: "별칭 해소 (alias)", color: "#d1569b", rest: 64, k: 0.035, on: false,
    why: "schema.md 상 `aliases`는 검색 손잡이(동의어·약어·교차언어)이지 페이지-페이지 링크가 아니다. 검색어→페이지를 잇는다.",
    role: "흐릿한 기억('제멜바이스', 'Grok shock')으로 페이지를 찾게 함. 그래서 문서 간 엣지는 거의 없다(구조적 진실)." },
  { key: "tag", label: "태그 공유 (#hub)", color: "#159e8a", rest: 56, k: 0.03, on: false,
    why: "`tags`는 bounded-vocab 주제 태그 (enrich 3칸 중 하나). 여러 문서가 같은 태그를 공유한다.",
    role: "폴더가 달라도 같은 주제로 교차 그룹핑. #허브를 통해 주제 클러스터를 드러낸다." },
  { key: "domain", label: "도메인 (폐기된 필드)", color: "#b0559e", rest: 70, k: 0.028, on: false,
    why: "`domain:` frontmatter 필드는 **폐기됐다** (2026-07-05 결정 — 소속은 경로/토폴로지가 선언, 교차분류는 `tags`). 마이그레이션 후 이 레이어는 비어야 정상이다.",
    role: "잔존 `domain:` 값을 drift 로 표시한다 — 허브/엣지가 하나라도 보이면 아직 폐기 필드가 남은 문서가 있다는 신호(count 0 = 정합)." },
  { key: "schema", label: "스키마 타입 (type/kind)", color: "#b0873a", rest: 70, k: 0.028, on: false,
    why: "`type`(special/decisions·special/dispatch-log·sidecar·tech…)·`kind` 스키마 분류 필드.",
    role: "문서의 '종류/역할'로 묶음 — 결정·디스패치로그·사이드카 같은 특수 파일 계약을 드러낸다." },
  { key: "project", label: "프로젝트", color: "#3f7fd6", rest: 66, k: 0.03, on: false,
    why: "`project:` frontmatter — 이 산출물이 속한 프로젝트 슬러그 (kuma-studio·farmers-story…).",
    role: "프로젝트별 산출물을 한 허브로 묶는다. plans 서브트리가 서로 연결되는 주 경로." },
  { key: "planline", label: "플랜 계보 (parent_plan)", color: "#22a06b", rest: 52, k: 0.04, on: false,
    why: "`parent_plan:` — 플랜이 자신의 부모 플랜을 가리키는 체인 (plan id `<project>/<stem>`).",
    role: "플랜의 부모-자식 계보/오케스트레이션 흐름. 마스터 플랜에서 파생 플랜까지의 갈래." },
];

function renderHtml(d) {
  const json = JSON.stringify(d).replace(/</g, "\\u003c");
  const layerJson = JSON.stringify(LAYER_META).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Kuma Vault — Topology Graph</title>
<style>
  :root{--bg:#ffffff;--panel:#fafafc;--line:#ececf1;--line2:#e3e3ea;--ink:#1b1b21;--muted:#8a8a96;--muted2:#abaeb8;--accent:#5b5bd6;--soft:#eeeefb;--hover:#f3f3f8}
  *{box-sizing:border-box}html,body{height:100%;margin:0}
  body{font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo",system-ui,sans-serif;color:var(--ink);background:var(--bg);overflow:hidden}
  .wrap{display:grid;grid-template-columns:300px 1fr;height:100vh}
  .side{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .brand{display:flex;align-items:center;gap:9px;padding:14px 16px 4px}.brand svg{width:19px;height:19px;color:var(--accent)}.brand b{font-size:13.5px}
  .intro{padding:0 16px 8px;color:var(--muted);font-size:11px;line-height:1.5}
  .stat{padding:0 16px 10px;color:var(--muted);font-size:11.5px}.stat b{color:var(--ink);font-variant-numeric:tabular-nums}
  .sbox{position:relative;margin:0 14px 10px}
  .sbox svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:var(--muted2)}
  .sbox input{width:100%;padding:8px 11px 8px 33px;border:1px solid var(--line2);border-radius:9px;background:#fff;font-size:13px;color:var(--ink);outline:none}
  .sbox input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--soft)}
  .scroll{overflow-y:auto;flex:1;padding:0 8px 12px}
  .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted2);padding:12px 8px 5px;display:flex;align-items:center;justify-content:space-between}
  .lbl .acts a{color:var(--accent);text-transform:none;letter-spacing:0;font-size:11px;cursor:pointer;text-decoration:none;margin-left:8px}
  .lgroup{margin:0}
  .row-t{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;text-align:left;padding:6px 8px;border-radius:8px;cursor:pointer;color:var(--ink);font-size:12.5px}
  .row-t:hover{background:var(--hover)}.row-t.off{opacity:.4}
  .sw{width:20px;height:11px;border-radius:3px;flex:0 0 auto;position:relative}
  .sw.edge::after{content:"";position:absolute;left:1px;right:1px;top:50%;height:2px;transform:translateY(-50%);border-radius:2px;background:currentColor}
  .row-t .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row-t .c{margin-left:auto;font-size:11px;color:var(--muted2);font-variant-numeric:tabular-nums;padding-left:6px}
  .iconbtn{flex:0 0 auto;width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--muted2);opacity:.6}
  .iconbtn:hover{background:var(--soft);color:var(--accent);opacity:1}.iconbtn svg{width:13px;height:13px}
  .linfo{display:none;margin:0 8px 8px 30px;padding:9px 11px;border:1px solid var(--line2);border-radius:9px;background:var(--bg);font-size:11.5px;line-height:1.5}
  .linfo.open{display:block}
  .linfo .li{margin-bottom:5px}.linfo .li:last-child{margin-bottom:0}
  .linfo b{display:inline-block;min-width:30px;color:var(--accent);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
  .linfo span{color:var(--ink)}
  .res{border:0;background:transparent;text-align:left;width:100%;display:block;padding:6px 8px;border-radius:7px;cursor:pointer}.res:hover{background:var(--hover)}
  .res .t{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.res .p{font-size:10.5px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .res mark{background:#fff2c2;border-radius:2px}
  .row-s{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;text-align:left;padding:6px 8px;border-radius:8px;cursor:pointer;color:var(--ink);font-size:12.5px}
  .row-s:hover{background:var(--hover)}.row-s.off{opacity:.4}.row-s .dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}.row-s .c{margin-left:auto;font-size:11px;color:var(--muted2)}
  .foot{border-top:1px solid var(--line);padding:10px 14px;display:flex;flex-direction:column;gap:8px}
  .seg{display:flex;background:var(--hover);border-radius:9px;padding:3px}.seg button{flex:1;border:0;background:transparent;padding:6px 0;border-radius:7px;font-size:12px;color:var(--muted);cursor:pointer}.seg button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06);font-weight:600}
  .stage{position:relative;overflow:hidden}canvas{display:block;width:100%;height:100%}
  .hint{position:absolute;left:14px;bottom:12px;color:var(--muted2);font-size:11px;pointer-events:none;user-select:none}
  #tip{position:absolute;pointer-events:none;background:rgba(28,28,34,.96);color:#fff;font-size:11.5px;padding:6px 9px;border-radius:7px;max-width:300px;display:none;z-index:5;line-height:1.35}#tip .tp{color:#b9b9c9;font-size:10px;margin-top:2px}
  #detail{position:absolute;right:14px;top:14px;width:300px;background:#fff;border:1px solid var(--line2);border-radius:12px;box-shadow:0 8px 30px rgba(20,20,40,.12);padding:14px;display:none;z-index:6;max-height:calc(100vh - 28px);overflow:auto}
  #detail h3{margin:0 0 3px;font-size:14px;padding-right:20px}#detail .dp{color:var(--muted);font-size:11px;word-break:break-all;margin-bottom:8px}
  #detail .dl{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted2);margin:10px 0 5px}
  #detail a.nb{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;color:var(--ink);text-decoration:none;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#detail a.nb:hover{background:var(--hover)}
  #detail a.nb .el{width:14px;height:3px;border-radius:2px;flex:0 0 auto}#detail .close{position:absolute;right:10px;top:9px;border:0;background:transparent;color:var(--muted2);cursor:pointer;font-size:17px;line-height:1}
  .hops{display:flex;gap:5px;flex-wrap:wrap}.hops .hop{border:1px solid var(--line2);background:var(--bg);border-radius:7px;padding:4px 10px;font-size:11.5px;color:var(--ink);cursor:pointer}.hops .hop:hover{background:var(--hover)}.hops .hop.on{background:var(--soft);border-color:var(--accent);color:var(--accent);font-weight:600}
  .treeview{display:none;position:absolute;inset:0;background:var(--bg);overflow:auto;padding:18px 22px}
  .trow{display:flex;align-items:center;gap:7px;padding:3px 8px;border-radius:6px;cursor:pointer}.trow:hover{background:var(--hover)}.trow .chev{width:11px;height:11px;color:var(--muted2);transition:transform .12s}.trow.open .chev{transform:rotate(90deg)}.trow svg.ic{width:14px;height:14px;color:var(--muted)}.trow .fc{margin-left:auto;font-size:10.5px;color:var(--muted2)}.trow.doc .nm{color:#4b4b55}.tkids{margin-left:14px;border-left:1px solid var(--line);padding-left:5px;display:none}.tkids.open{display:block}
  @media (prefers-color-scheme:dark){:root{--bg:#161619;--panel:#1c1c21;--line:#29292f;--line2:#33333b;--ink:#e8e8ee;--muted:#9a9aa6;--muted2:#6c6c78;--accent:#a9a9f5;--soft:#26263a;--hover:#232329}.sbox input,#detail{background:#111116}.seg button.on{background:#2a2a31}.res mark{background:#5a4a1a;color:#f0e4b0}}
</style></head>
<body>
<div class="wrap">
  <aside class="side">
    <div class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="8" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.6 7.2 10.6 16M16.4 9.6 13 16.4M8 6.6h7.8"/></svg><b>Kuma Vault · Topology${d.union ? " · UNION" : ""}</b></div>
    <div class="intro">vault의 지식이 서로 어떻게 연결되는지를 frontmatter 연결 방법론별 레이어로 나눠 보여줍니다. 각 레이어의 <b style="color:var(--accent)">ⓘ</b> = 왜/역할, <b style="color:var(--accent)">◎</b> = 이 분류만 보기.</div>
    <div class="stat">루트 <b id="sRoot"></b> · <b id="sD">0</b> 문서 · <b id="sF">0</b> 폴더</div>
    <div class="sbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg><input id="q" placeholder="문서·태그·프로젝트 검색…" autocomplete="off" spellcheck="false"/></div>
    <div class="scroll">
      <div id="results"></div>
      <div class="lbl">연결 방법론 (분류) <span class="acts"><a id="jumpRoot">시작점</a><a id="layAll">전체</a><a id="layDefault">기본</a></span></div>
      <div id="layers"></div>
      <div class="lbl">Sections <span class="acts"><a id="secAll">전체</a><a id="secDefault">기본</a></span></div>
      <div id="legend"></div>
    </div>
    <div class="foot"><div class="seg"><button id="vG" class="on">그래프</button><button id="vT">트리</button></div></div>
  </aside>
  <main class="stage">
    <canvas id="cv"></canvas><div id="tip"></div><div id="detail"></div>
    <div class="hint">휠=확대 · 드래그=이동 · 클릭=이웃 · 상세패널 N홉=이 노드 주변만 (Esc=해제) · ⓘ=설명 · ◎=이 분류만</div>
    <div class="treeview" id="treeview"></div>
  </main>
</div>
<script>
const D = ${json};
const LAYERS = ${layerJson};
const NODES = D.nodes, N = NODES.length;
const SECFIX={domains:"#6d5bd0",projects:"#d98a2b",learnings:"#22a06b",memos:"#d1569b",inbox:"#7b8494",lessons:"#3f9dd6","operational-rules":"#c9564f",calendar:"#b0873a",results:"#8a8f52",recordings:"#9a63c9",docs:"#4f948d",plans:"#c87a3a",stores:"#7d7db8",images:"#9a9aa6","_archive":"#9a9aa6","_diagrams":"#7d7db8","(root)":"#5b5bd6"};
const PAL=["#6d5bd0","#d98a2b","#22a06b","#d1569b","#3f9dd6","#c9564f","#9a63c9","#4f948d","#b0873a","#7d7db8"];
const sections=Object.keys(D.sectionCounts).sort(); const secColor={}; let pi=0; for(const s of sections) secColor[s]=SECFIX[s]||PAL[pi++%PAL.length];
const HUBCOLOR={tag:"#159e8a",domain:"#b0559e",schema:"#b0873a",project:"#3f7fd6",xstore:"#d04f4f"};
const layerOn={},layerColor={}; LAYERS.forEach(L=>{layerOn[L.key]=L.on;layerColor[L.key]=L.color;});
// Operational-artifact sections (plan docs, run results, archives) are ~94% of the documents
// and drown the knowledge topology, so they start hidden — still listed (dimmed, with counts)
// in the Sections legend, one click to bring back. Matched on the LAST path segment so a
// union view's store-prefixed sections ("acme-ops:archive") dim the same way.
const DIMTAIL=new Set(["plans","results","_archive","archive"]);
const isDim=s=>DIMTAIL.has(s.split(":").pop());
const visible=new Set(sections.filter(s=>!isDim(s))); const deg=NODES.map(n=>n.deg);
function nodeColor(i){ const n=NODES[i]; if(n.type==="root")return "#20202a"; if(n.type==="xdoc")return "#d98a7f"; if(HUBCOLOR[n.type])return HUBCOLOR[n.type]; return secColor[n.sec]||"#8a8a96"; }

let shown=new Uint8Array(N), activeEdges=[];
let focusI=-1,focusD=0; // ego view: -1 = off, else show only nodes within focusD hops of focusI
function secOK(i){ const n=NODES[i]; return (n.type==="folder"||n.type==="doc")?visible.has(n.sec):true; }
function recompute(){ shown=new Uint8Array(N); activeEdges=[];
  for(const L of LAYERS){ if(!layerOn[L.key])continue; for(const [a,b] of D.layers[L.key]){ if(!secOK(a)||!secOK(b))continue; shown[a]=1;shown[b]=1; activeEdges.push([a,b,L.rest,L.k,L.color,L.w||1]); } }
  if(layerOn.hier)for(const r of D.rootIdxs)shown[r]=1;
  if(focusI>=0){ // local-graph filter: BFS over the ACTIVE edges only — what remains is exactly "how this node is connected"
    shown[focusI]=1;
    const dist=new Int32Array(N).fill(-1); dist[focusI]=0;
    const adj=new Map(); for(const [a,b] of activeEdges){ if(!shown[a]||!shown[b])continue; if(!adj.has(a))adj.set(a,[]); if(!adj.has(b))adj.set(b,[]); adj.get(a).push(b); adj.get(b).push(a); }
    const q=[focusI]; let qi=0;
    while(qi<q.length){ const v=q[qi++]; if(dist[v]>=focusD)continue; for(const w of (adj.get(v)||[])){ if(dist[w]<0){ dist[w]=dist[v]+1; q.push(w); } } }
    for(let i=0;i<N;i++) if(shown[i]&&dist[i]<0) shown[i]=0;
    activeEdges=activeEdges.filter(([a,b])=>shown[a]&&shown[b]);
  } }
recompute();
function neighborsOf(i){ const out=[]; for(const [a,b,,,col] of activeEdges){ if(a===i)out.push([b,col]); else if(b===i)out.push([a,col]); } return out; }

const x=new Float64Array(N),y=new Float64Array(N),vx=new Float64Array(N),vy=new Float64Array(N),fixed=new Int8Array(N);
// Per-store gravity anchors, laid out along the x axis with a real gap. Every node is pulled
// toward ITS OWN store's anchor — never a shared center — so two stores end up overlapping
// only if edges actually pull them together: on-screen distance now means connectivity.
const stOf=i=>NODES[i].st||0;
const SR=D.stores.map(s=>Math.max(320,Math.sqrt(s.docs+1)*22));
const ANCH=[[0,0]];{let cx=0;for(let i=1;i<D.stores.length;i++){cx+=SR[i-1]+SR[i]+420;ANCH.push([cx,0]);}}
// Section sub-anchors: each section gets a stable slot on a ring inside its store, and its
// nodes drift there under a weak pull — the hairball separates into same-colored continents
// without adding or removing a single edge.
const secAnchor={};{
  const byStore=new Map();
  for(const n of NODES){ if((n.type==="folder"||n.type==="doc")&&!(n.sec in secAnchor)){ const st=n.st||0; if(!byStore.has(st))byStore.set(st,[]); byStore.get(st).push(n.sec); secAnchor[n.sec]=null; } }
  for(const [st,secs] of byStore){ secs.sort(); const A=ANCH[st]; secs.forEach((s,j)=>{ const a=j/secs.length*6.283; secAnchor[s]=[A[0]+Math.cos(a)*SR[st]*0.62, A[1]+Math.sin(a)*SR[st]*0.62]; }); }
}
for(let i=0;i<N;i++){ const st=stOf(i),A=ANCH[st]||ANCH[0]; const a=Math.random()*6.283,r=Math.sqrt(Math.random())*SR[st]; x[i]=A[0]+Math.cos(a)*r; y[i]=A[1]+Math.sin(a)*r; }
for(const ri of D.rootIdxs){ const A=ANCH[stOf(ri)]||ANCH[0]; x[ri]=A[0];y[ri]=A[1];fixed[ri]=1; }
let alpha=1; const REPULSE=1700,GRAV=0.011,SECG=0.006,DAMP=0.85,CELL=72,MAXV=40;
const RAD=new Float64Array(N); for(let ri=0;ri<N;ri++)RAD[ri]=radius(ri); // static radii cache (deg is fixed)
function physics(){
  const grid=new Map();
  for(let i=0;i<N;i++){ if(!shown[i])continue; const key=(Math.floor(x[i]/CELL))+","+(Math.floor(y[i]/CELL)); let a=grid.get(key); if(!a){a=[];grid.set(key,a);} a.push(i); }
  for(let i=0;i<N;i++){ if(!shown[i])continue; const cx=Math.floor(x[i]/CELL),cy=Math.floor(y[i]/CELL);
    for(let gx=cx-1;gx<=cx+1;gx++)for(let gy=cy-1;gy<=cy+1;gy++){ const arr=grid.get(gx+","+gy); if(!arr)continue;
      for(const j of arr){ if(j<=i)continue; let dx=x[i]-x[j],dy=y[i]-y[j]; let d2=dx*dx+dy*dy; if(d2>CELL*CELL*9)continue; if(d2<0.02){dx=Math.random()-.5;dy=Math.random()-.5;d2=dx*dx+dy*dy||0.02;} const dd=Math.sqrt(d2); let f=REPULSE/d2; if(f>30)f=30; const minD=RAD[i]+RAD[j]+4; if(dd<minD)f+=(minD-dd)*1.3; const fx=dx/dd*f,fy=dy/dd*f; vx[i]+=fx;vy[i]+=fy;vx[j]-=fx;vy[j]-=fy; } }
  }
  for(const [a,b,rest,k] of activeEdges){ let dx=x[b]-x[a],dy=y[b]-y[a]; const dd=Math.hypot(dx,dy)||.01; const f=(dd-rest)*k; const fx=dx/dd*f,fy=dy/dd*f; vx[a]+=fx;vy[a]+=fy;vx[b]-=fx;vy[b]-=fy; }
  for(let i=0;i<N;i++){ if(!shown[i]||fixed[i])continue; const A=ANCH[stOf(i)]||ANCH[0]; vx[i]-=(x[i]-A[0])*GRAV; vy[i]-=(y[i]-A[1])*GRAV; const sa=secAnchor[NODES[i].sec]; if(sa){ vx[i]-=(x[i]-sa[0])*SECG; vy[i]-=(y[i]-sa[1])*SECG; } vx[i]*=DAMP; vy[i]*=DAMP; const sp=Math.hypot(vx[i],vy[i]); if(sp>MAXV){vx[i]*=MAXV/sp;vy[i]*=MAXV/sp;} x[i]+=vx[i]*alpha; y[i]+=vy[i]*alpha; }
  alpha*=0.992;
}
function reheat(v){ alpha=Math.max(alpha,v||0.5); wake(); }

const cv=document.getElementById("cv"),ctx=cv.getContext("2d");
let DPR=Math.min(devicePixelRatio||1,2),W=0,H=0,cam={x:0,y:0,k:1};
function resize(){ const st=cv.parentElement.getBoundingClientRect(); W=st.width;H=st.height; cv.width=W*DPR;cv.height=H*DPR; cv.style.width=W+"px";cv.style.height=H+"px"; }
addEventListener("resize",()=>{ resize(); wake(); }); resize();
function s2w(px,py){ return [(px-W/2)/cam.k-cam.x,(py-H/2)/cam.k-cam.y]; }
let userMoved=false;
function fit(){ const xs=[],ys=[]; for(let i=0;i<N;i++){ if(!shown[i])continue; xs.push(x[i]);ys.push(y[i]); } if(!xs.length)return; xs.sort((a,b)=>a-b);ys.sort((a,b)=>a-b); const q=(t,p)=>t[Math.min(t.length-1,Math.max(0,Math.floor(t.length*p)))]; const mnx=q(xs,.02),mxx=q(xs,.98),mny=q(ys,.02),mxy=q(ys,.98); const w=mxx-mnx||1,h=mxy-mny||1; cam.k=Math.max(.04,Math.min(W/(w+150),H/(h+150),1.8)); cam.x=-(mnx+mxx)/2;cam.y=-(mny+mxy)/2; }
function radius(i){ const n=NODES[i]; if(n.type==="root")return 13; if(HUBCOLOR[n.type])return 5.5+Math.min(8,Math.sqrt(deg[i])*1.3); if(n.type==="folder")return 4+Math.min(8,Math.sqrt(deg[i])*1.3); return 2.6+Math.min(5,Math.sqrt(deg[i])*1.2); }
function isHub(i){ return !!HUBCOLOR[NODES[i].type]; }

let hover=-1,selected=-1,hiSet=null,query="";
let dragMode="",lastX=0,lastY=0,moved=0,dragNode=-1;
cv.addEventListener("mousedown",e=>{ const r=cv.getBoundingClientRect(); const i=pick(e.clientX-r.left,e.clientY-r.top); lastX=e.clientX;lastY=e.clientY;moved=0; if(i>=0){dragMode="node";dragNode=i;fixed[i]=1;reheat(.6);} else dragMode="pan"; });
addEventListener("mouseup",()=>{ if(dragMode==="node"&&dragNode>=0&&dragNode!==D.rootIdx)fixed[dragNode]=0; dragMode="";dragNode=-1; });
cv.addEventListener("mousemove",e=>{ const r=cv.getBoundingClientRect(); const mx=e.clientX-r.left,my=e.clientY-r.top;
  if(dragMode==="pan"){ userMoved=true; cam.x+=(e.clientX-lastX)/cam.k;cam.y+=(e.clientY-lastY)/cam.k;lastX=e.clientX;lastY=e.clientY;moved+=8;hideTip();wake();return; }
  if(dragMode==="node"){ userMoved=true; const [wx,wy]=s2w(mx,my); x[dragNode]=wx;y[dragNode]=wy;vx[dragNode]=0;vy[dragNode]=0;moved+=8;reheat(.3);hideTip();return; }
  const prevHover=hover; const i=pick(mx,my); hover=i; const tip=document.getElementById("tip");
  if(i>=0){ const n=NODES[i]; tip.style.display="block";tip.style.left=(mx+16)+"px";tip.style.top=(my+12)+"px"; tip.innerHTML='<div>'+esc(n.title)+'</div><div class="tp">'+esc(typeLabel(n))+' · '+deg[i]+' links</div>'; cv.style.cursor="pointer"; } else { hideTip(); cv.style.cursor="grab"; }
  if(hover!==prevHover)wake(); });
cv.addEventListener("mouseleave",()=>{ hover=-1; hideTip(); wake(); }); function hideTip(){ document.getElementById("tip").style.display="none"; }
cv.addEventListener("click",e=>{ if(moved>4)return; const r=cv.getBoundingClientRect(); select(pick(e.clientX-r.left,e.clientY-r.top)); });
cv.addEventListener("wheel",e=>{ e.preventDefault();userMoved=true; const r=cv.getBoundingClientRect(); const mx=e.clientX-r.left,my=e.clientY-r.top; const [wx,wy]=s2w(mx,my); cam.k=Math.max(.04,Math.min(6,cam.k*Math.exp(-e.deltaY*0.0016))); const [wx2,wy2]=s2w(mx,my); cam.x+=wx2-wx;cam.y+=wy2-wy; wake(); },{passive:false});
function pick(mx,my){ const [wx,wy]=s2w(mx,my); let best=-1,bd=1e9; for(let i=0;i<N;i++){ if(!shown[i])continue; const dx=x[i]-wx,dy=y[i]-wy,dd=dx*dx+dy*dy; const rr=(RAD[i]+5)/cam.k; if(dd<rr*rr&&dd<bd){bd=dd;best=i;} } return best; }
function typeLabel(n){ return n.type==="root"?"루트":n.type==="folder"?"폴더 · "+n.sec:n.type==="tag"?"태그":n.type==="domain"?"도메인":n.type==="schema"?"스키마 타입":n.type==="project"?"프로젝트":n.type==="xstore"?"외부 저장소":n.type==="xdoc"?"외부 문서 · "+n.sec:n.sec; }
function select(i){ selected=i; const det=document.getElementById("detail");
  if(i<0){ hiSet=null;det.style.display="none";wake();return; }
  const nb=neighborsOf(i); hiSet=new Set([i]); nb.forEach(([j])=>hiSet.add(j));
  const uniq=new Map(); nb.forEach(([j,col])=>{ if(!uniq.has(j))uniq.set(j,col); }); const list=[...uniq.entries()].map(([j,col])=>({j,col,n:NODES[j]})).sort((a,b)=>a.n.title.localeCompare(b.n.title));
  const n=NODES[i]; det.style.display="block";
  det.innerHTML='<button class="close">×</button><h3>'+esc(n.title)+'</h3><div class="dp"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+nodeColor(i)+';margin-right:5px;vertical-align:middle"></span>'+esc(typeLabel(n))+(n.id.startsWith("doc:")?' · '+esc(n.id.slice(4)):n.id.startsWith("xdoc:")?' · '+esc(n.id.slice(5)):'')+'</div>'
    +'<div class="dl">이 노드 주변만 보기</div><div class="hops">'+[1,2,3].map(h=>'<button class="hop'+(focusI===i&&focusD===h?" on":"")+'" data-h="'+h+'">'+h+'홉</button>').join('')+(focusI>=0?'<button class="hop" data-h="0">전체로</button>':'')+'</div>'
    +'<div class="dl">활성 분류 연결 '+list.length+'</div>'+(list.length?list.map(o=>'<a class="nb" data-i="'+o.j+'"><span class="el" style="background:'+o.col+'"></span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+nodeColor(o.j)+'"></span>'+esc(o.n.title)+'</a>').join(''):'<div style="color:var(--muted);font-size:12px">활성 분류에서 연결 없음. 다른 레이어를 켜보세요.</div>');
  det.querySelector(".close").onclick=()=>select(-1);
  det.querySelectorAll(".hop").forEach(b=>b.onclick=()=>{ const h=+b.dataset.h; if(h===0){ focusI=-1; focusD=0; } else { focusI=i; focusD=h; } userMoved=false; recompute(); reheat(.6); select(i); });
  det.querySelectorAll(".nb").forEach(a=>a.onclick=()=>{ const j=+a.dataset.i; centerOn(j);select(j); }); wake(); }
function centerOn(i){ userMoved=true; cam.x=-x[i];cam.y=-y[i]; cam.k=Math.max(cam.k,1.1); wake(); }

const q=document.getElementById("q"),resEl=document.getElementById("results");
q.oninput=()=>{ query=q.value.trim().toLowerCase(); if(!query){ resEl.innerHTML="";return; }
  const hits=[]; for(let i=0;i<N;i++){ const n=NODES[i]; if((n.title+" "+n.id).toLowerCase().includes(query)){ hits.push(i); if(hits.length>=40)break; } }
  resEl.innerHTML='<div class="lbl">검색 '+hits.length+(hits.length>=40?"+":"")+'</div>'+hits.map(i=>{ const n=NODES[i]; return '<button class="res" data-i="'+i+'"><div class="t"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+nodeColor(i)+';margin-right:6px;vertical-align:middle"></span>'+hl(n.title)+'</div><div class="p">'+hl(n.id.replace(/^(doc:|dir:|tag:|dom:|sch:|prj:)/,""))+'</div></button>'; }).join('');
  resEl.querySelectorAll(".res").forEach(b=>b.onclick=()=>{ const i=+b.dataset.i; const n=NODES[i]; if((n.type==="folder"||n.type==="doc")&&!visible.has(n.sec)){visible.add(n.sec);renderLegend();recompute();reheat();} if(!shown[i]){ const map={tag:"tag",domain:"domain",schema:"schema",project:"project",xstore:"xstore",xdoc:"xstore"}; if(map[n.type]){layerOn[map[n.type]]=true;renderLayers();recompute();reheat();} } centerOn(i);select(i); }); };
function hl(t){ t=String(t); const i=t.toLowerCase().indexOf(query); if(i<0)return esc(t); return esc(t.slice(0,i))+"<mark>"+esc(t.slice(i,i+query.length))+"</mark>"+esc(t.slice(i+query.length)); }

const layersEl=document.getElementById("layers"),legEl=document.getElementById("legend");
const SOLO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/></svg>';
const INFO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/></svg>';
function renderLayers(){ layersEl.innerHTML=LAYERS.map(L=>'<div class="lgroup"><div class="row-t'+(layerOn[L.key]?"":" off")+'" data-k="'+L.key+'"><span class="sw edge" style="color:'+L.color+';background:'+L.color+'22"></span><span class="nm">'+esc(L.label)+'</span><span class="c">'+(D.counts[L.key]||0)+'</span><span class="iconbtn info" data-info="'+L.key+'" title="왜/역할">'+INFO+'</span><span class="iconbtn solo" data-solo="'+L.key+'" title="이 분류만 보기">'+SOLO+'</span></div><div class="linfo" id="linfo-'+L.key+'"><div class="li"><b>왜</b><span>'+esc(L.why)+'</span></div><div class="li"><b>역할</b><span>'+esc(L.role)+'</span></div></div></div>').join('');
  layersEl.querySelectorAll(".row-t").forEach(row=>row.onclick=e=>{ const k=row.dataset.k; if(e.target.closest(".info")){ const el=document.getElementById("linfo-"+k); el.classList.toggle("open"); } else if(e.target.closest(".solo")){ solo(k); } else { layerOn[k]=!layerOn[k]; syncRowClasses(); if(selected>=0)select(selected); recompute(); reheat(.7); } }); }
function syncRowClasses(){ layersEl.querySelectorAll(".row-t").forEach(r=>r.classList.toggle("off",!layerOn[r.dataset.k])); }
function solo(k){ LAYERS.forEach(L=>layerOn[L.key]=(L.key===k)); syncRowClasses(); if(selected>=0)select(selected); recompute(); reheat(.8); }
function renderLegend(){ legEl.innerHTML=sections.map(s=>'<div class="row-s'+(visible.has(s)?"":" off")+'" data-s="'+esc(s)+'"><span class="dot" style="background:'+secColor[s]+'"></span><span class="nm">'+esc(s)+'</span><span class="c">'+D.sectionCounts[s]+'</span></div>').join('');
  legEl.querySelectorAll(".row-s").forEach(b=>b.onclick=()=>{ const s=b.dataset.s; if(visible.has(s))visible.delete(s); else visible.add(s); b.classList.toggle("off",!visible.has(s)); recompute(); reheat(.6); }); }
renderLayers(); renderLegend();
document.getElementById("jumpRoot").onclick=()=>{ centerOn(D.rootIdx); select(D.rootIdx); };
document.getElementById("layAll").onclick=()=>{ LAYERS.forEach(L=>layerOn[L.key]=true); syncRowClasses(); recompute(); reheat(.8); };
document.getElementById("layDefault").onclick=()=>{ LAYERS.forEach(L=>layerOn[L.key]=L.on); syncRowClasses(); recompute(); reheat(.8); };
document.getElementById("secAll").onclick=()=>{ sections.forEach(s=>visible.add(s)); renderLegend(); recompute(); reheat(.8); };
document.getElementById("secDefault").onclick=()=>{ visible.clear(); sections.forEach(s=>{ if(!isDim(s))visible.add(s); }); renderLegend(); recompute(); reheat(.8); };

const vG=document.getElementById("vG"),vT=document.getElementById("vT"),treeview=document.getElementById("treeview");
vG.onclick=()=>{ vG.classList.add("on");vT.classList.remove("on");treeview.style.display="none"; };
vT.onclick=()=>{ vT.classList.add("on");vG.classList.remove("on");treeview.style.display="block";renderTree(); };
function treeNodeHtml(node,depth){ let h='<div><div class="trow'+(depth<1?" open":"")+'"><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="nm">'+esc(node.name)+'</span><span class="fc">'+node.count+'</span></div><div class="tkids'+(depth<1?" open":"")+'">';
  for(const f of node.folders)h+=treeNodeHtml(f,depth+1);
  for(const dc of node.docs)h+='<div class="trow doc" data-i="'+dc.idx+'"><span style="width:11px"></span><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/></svg><span class="nm">'+esc(dc.title)+'</span></div>';
  h+='</div></div>';return h; }
let treeBuilt=false;
function renderTree(){ if(treeBuilt)return; treeview.innerHTML=D.tree.map(t=>treeNodeHtml(t,0)).join(''); treeBuilt=true;
  treeview.querySelectorAll(".trow:not(.doc)").forEach(r=>r.onclick=()=>{ r.classList.toggle("open"); const k=r.nextElementSibling; if(k&&k.classList.contains("tkids"))k.classList.toggle("open"); });
  treeview.querySelectorAll(".trow.doc").forEach(r=>r.onclick=()=>{ vG.click(); const i=+r.dataset.i; const n=NODES[i]; if(!visible.has(n.sec)){visible.add(n.sec);renderLegend();recompute();reheat();} centerOn(i);select(i); }); }

function draw(){
  ctx.setTransform(DPR,0,0,DPR,0,0); ctx.clearRect(0,0,W,H);
  ctx.save(); ctx.translate(W/2,H/2); ctx.scale(cam.k,cam.k); ctx.translate(cam.x,cam.y);
  ctx.lineWidth=1/cam.k; let cur=null;
  for(const [a,b,,,col,w] of activeEdges){ if(!shown[a]||!shown[b])continue; if(hiSet&&!(hiSet.has(a)&&hiSet.has(b)))continue; const key=col+"|"+w; if(key!==cur){ if(cur!==null)ctx.stroke(); ctx.beginPath(); ctx.strokeStyle=col; ctx.lineWidth=(w||1)/cam.k; ctx.globalAlpha=hiSet?0.92:0.5; cur=key; } ctx.moveTo(x[a],y[a]);ctx.lineTo(x[b],y[b]); }
  if(cur!==null)ctx.stroke(); ctx.globalAlpha=1;
  for(let i=0;i<N;i++){ if(!shown[i])continue; const dim=(hiSet&&!hiSet.has(i))||(query&&!(NODES[i].title+" "+NODES[i].id).toLowerCase().includes(query)); ctx.globalAlpha=dim?0.12:1; const rr=RAD[i]; ctx.beginPath();
    if(isHub(i)){ ctx.save();ctx.translate(x[i],y[i]);ctx.rotate(.785);ctx.rect(-rr*.8,-rr*.8,rr*1.6,rr*1.6);ctx.restore(); } else ctx.arc(x[i],y[i],rr,0,6.283);
    ctx.fillStyle=nodeColor(i); ctx.fill();
    if(NODES[i].type==="root"){ ctx.lineWidth=3/cam.k;ctx.strokeStyle="#fff";ctx.stroke(); }
    if(i===selected||i===hover){ ctx.lineWidth=2/cam.k;ctx.strokeStyle="#fff";ctx.stroke();ctx.lineWidth=1.4/cam.k;ctx.strokeStyle=nodeColor(i);ctx.stroke(); } }
  ctx.globalAlpha=1;
  ctx.save(); ctx.scale(1/cam.k,1/cam.k); ctx.textAlign="center";
  const cs=getComputedStyle(document.body),BG=cs.getPropertyValue("--bg"),INK=cs.getPropertyValue("--ink");
  const lab=(i)=>{ const t=NODES[i].type; if(t==="root")return true; if(i===selected||i===hover||(hiSet&&hiSet.has(i)))return true; if(isHub(i))return cam.k>0.5||deg[i]>=12; if(t==="folder")return cam.k>0.32||deg[i]>=30; return cam.k>1.7&&deg[i]>=2; };
  for(let i=0;i<N;i++){ if(!shown[i]||!lab(i))continue; if(hiSet&&!hiSet.has(i))continue; if(query&&!(NODES[i].title+" "+NODES[i].id).toLowerCase().includes(query)&&!(hiSet&&hiSet.has(i)))continue; const sx=x[i]*cam.k,sy=y[i]*cam.k; const big=NODES[i].type==="root"; ctx.font=(big?"600 13px":"12px")+" -apple-system,system-ui,sans-serif"; const t=NODES[i].title.length>30?NODES[i].title.slice(0,29)+"…":NODES[i].title; ctx.globalAlpha=.92; ctx.lineWidth=3;ctx.strokeStyle=BG; ctx.strokeText(t,sx,sy-RAD[i]*cam.k-4); ctx.fillStyle=INK; ctx.fillText(t,sx,sy-RAD[i]*cam.k-4); }
  ctx.restore(); ctx.globalAlpha=1; ctx.restore();
}
// Render-on-demand: while the layout is hot (alpha above the floor) the loop self-sustains;
// once it cools and nothing is interacting it stops requesting frames (idle = 0 CPU). Any
// interaction (drag/pan/zoom/hover/select/toggle) calls wake() to draw one frame, and reheat()
// wakes + reheats to resume the simulation.
let rafOn=false;
function wake(){ if(!rafOn){ rafOn=true; requestAnimationFrame(frame); } }
function frame(){ rafOn=false; const hot=alpha>0.02; if(hot)physics(); if(!userMoved)fit(); draw(); if(hot)wake(); }
document.getElementById("sRoot").textContent=D.union?D.stores.map(s=>s.storeId).join(" + "):D.rootName; document.getElementById("sD").textContent=D.counts.docs; document.getElementById("sF").textContent=D.counts.folders;
for(let t=0;t<300;t++)physics(); fit(); wake();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",wake);
function esc(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
addEventListener("keydown",e=>{ if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();q.focus();} if(e.key==="Escape"){ if(focusI>=0){ focusI=-1; focusD=0; userMoved=false; recompute(); reheat(.5); } select(-1); } });
</script></body></html>`;
}
