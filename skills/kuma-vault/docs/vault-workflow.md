# Vault Workflow Rules — Ingest / Query / Lint

## Summary
볼트의 3 operation(Ingest / Query / Lint)을 실제 집행하는 룰. 실행 모델은 topology-first + canonical-owner-first 다. 아키텍처 이름·불변식은 [architecture.md](~/.kuma/vault/architecture.md), slot contract·page rules 는 [schema.md](~/.kuma/vault/schema.md) 가 SSoT 이고, 본 문서는 그 위의 operation 실행 contract 를 소유한다.

### Why
- "Ingest 할 때 raw 부터 저장" 모델은 폐기했다. 새 source 는 owner-local evidence / TTL 있는 inbox 로 들어간다.
- Lint 가 없으면 볼트가 stale·orphan·contradiction 으로 녹는다.
- Query 결과가 file-back 안 되면 지식이 compounding 하지 않는다.

### How to apply
각 operation 마다 아래 룰을 따른다. 룰 변경은 이 문서에서 한다 (drift 방지).

## Rules

### I — Ingest rules

#### I1 — Canonical owner first (새 source 기준)
새 source 를 받으면 **canonical owner 를 먼저 정한 뒤** source/evidence 를 owner-local `_assets/`, `_sources/`, `_evidence/`, domain catalog, 또는 `results/` 에 보존한다. owner 가 불명확하면 `inbox/` 에 owner/TTL/next-action 을 붙인다. top-level `raw/` 는 제거됐으며 신규 기본 경로가 아니다.
- **Why:** 원본 보존은 필요하지만 global raw-first 는 owner/currentness/정리 상태를 흐려 agentic search 를 오염시킨다. Topology 가 owner 를 정하고 tags/aliases 가 retrieval 을 돕는 구조가 현재 운영에 맞다.
- **How to apply:**
  1. 공개 URL → `/insane-search` (WAF/차단 사이트는 TLS impersonate, 아니면 curl/Jina) 로 원문 스크랩.
  2. source 의 canonical owner 를 정한다: `domains/`, `projects/`, `learnings/`, `calendar/`, 또는 owner folder `README.md`.
  3. owner 가 명확하면 source/evidence 를 owner-local `_sources/` 또는 `_evidence/` 에 저장하고 canonical page 의 `Sources`/본문에 링크한다.
  4. owner 가 불명확하면 `inbox/` 에 저장하고 sidecar/frontmatter 에 `owner`, `ttl`, `next_action`, `source` 를 기록한다.
  5. 원본 스크랩 실패 시: canonical page 또는 inbox note 에 "source 미확보 — URL 만 기록" 명시. 조용히 넘어가지 않는다 (No Silent Fallback).
- **면제:** 공개 repo(`gh api` 로 언제든 재확보), API 스펙(공식 docs URL 이 canonical), Alex 직접 작성한 유저 채팅/메모.

#### I2 — README topology 와 log 동시 갱신
새 페이지 생성·삭제·rename 시 부모 폴더의 `README.md` reachability 와 `log.md` 를 **같은 작업 단위** 에서 갱신한다.
- **Why:** canonical navigation 은 root `README.md` → folder `README.md` chain 이다. 문서가 부모 README 에서 도달 불가하면 search/get 은 찾더라도 사람이 topology 로 검토할 수 없다.
- **How to apply:** 새 canonical page 는 같은 폴더 README 의 `<!-- vault-index:start/end -->` child region 에 도달 가능해야 한다. index region 은 파생 뷰이므로 손으로 맞추지 않는다 — `kuma vault sync` (또는 ingest 경로가 write 직후 인라인으로 호출하는 동일 `syncVaultIndex` 엔진) 가 live filesystem 의 직속 child set 에서 region 을 재생성한다 (content-hash idempotent, 2회차 no-op). `log.md` 에 `- INGEST:` / `- UPDATE:` / `- RENAME:` 태그로 기록한다.

#### I3 — Slot 결정은 schema 에 맞게
페이지를 배치할 slot 이 어디에도 안 맞으면 즉흥 디렉토리 생성 금지. `schema.md` 확장 결정 먼저.
- **Why:** topology-first canonical ([architecture.md](~/.kuma/vault/architecture.md) 불변식 1·2).

### Q — Query rules

#### Q1 — File-back 의무 (재사용 가치 있을 때)
Query 답변 중 **재사용 가능한 synthesis / comparison / analysis / canonical 사실 확정** 이 생기면 볼트로 file-back 한다.
- **Why:** 좋은 답변을 canonical page 로 file-back 해야 탐색 결과가 ingest 된 source 처럼 지식베이스에 compounding 한다. file-back 을 안 하면 `learnings/` 가 비어 다음 Query 가 매번 처음부터 탐색한다.
- **How to apply:**
  1. 답변 작성 후 self-check: "이 synthesis 가 다음 세션에도 재사용될까?"
  2. 재사용 값 있으면 `learnings/` (일반화 가능) 또는 `domains/` (특정 도메인) 에 canonical page 로 저장.
  3. 재사용 값 낮으면 저장 안 함 (`memos/` 도 사용 안 함 — memos 는 user-owned memo layer).
- **file-back 후보 판정 기준:**
  - **Yes:** 둘 이상의 source 를 합성한 결론, 유저가 반복해서 물을 수 있는 FAQ, 우리가 검증해서 확정한 fact, 개념 간 비교표, 의사결정 matrix.
  - **No:** 1회성 디버깅, 세션 한정 상태, 유저와의 잡담, 이미 canonical 에 있는 내용 반복.

#### Q2 — Vault-first (재확인)
`info-retrieval.md` R1 — 사실형 질의는 vault 1순위. file-back 된 learnings 가 있어야 다음 Query 가 거기서 멈춘다.

### L — Lint rules

#### L1 — 주기
- **Manual on-demand:** `vault lint` (kuma-vault 엔진 bin, `--json` 지원; `kuma vault lint` 동등) — 언제든 실행 가능한 프로그래매틱 체커. 트리 루트의 `vault.config.json` 자기선언이 root 와 계약을 함께 결정한다.
- **Event trigger:** architecture/schema 변경, 대규모 migrate, canonical reset 직후. 변경 영향 범위 확인.
- **Routine:** 월 1회 이상 LLM 패스 + 프로그래매틱 패스.

#### L2 — 프로그래매틱 패스 (기계 판정)
`vault lint` (kuma-vault 엔진 레포 `src/engine/vault-lint.mjs`) 가 자동 감지:
- **Full markdown scan** — fast mode 는 special files, full mode 는 image/asset dir 를 제외한 vault markdown 전량.
- **Dead relative links** — `[...](path.md)` 또는 `[...](path.md#anchor)` 타겟 실존 여부. inline/fenced code 예시는 link 로 취급하지 않는다.
- **Special file sanity** — root `README.md`, `schema.md`, `log.md`, `decisions.md`, `dispatch-log.md` 존재 + frontmatter 필수 필드. `index.md` 는 retired file 이며 존재하면 lint 실패다.
- **Slot-specific contracts** — project summary, project decisions, calendar, memos, learnings, lessons, result archive, persona memory, category index 의 frontmatter/section contract.
- **Canonical drift** — project page 안 legacy ingest marker/result source leak, managed skill inbox leak, schema/runtime special-file mismatch.
- **Folder README topology** — navigable folder 는 `README.md` 를 가진다. sibling `X.md` + `X/` category-index 형태는 drift 다. asset/archive folders 는 per-item child index 예외지만 thin `README.md` 로 의도를 설명한다.
- **Reachability** — root `README.md` 에서 시작해 folder README 와 상대 링크를 따라 모든 navigable `.md` 가 도달 가능해야 한다. dead-link, orphan, case-mismatch, out-of-root, symlink-root escape, stale generated region 을 deterministic failure 로 보고한다.

#### L2a — Reachability lint contract (implemented)
- **Root:** canonical vault root 는 `realpath` 로 확정하고, 모든 resolved link 는 root containment 를 통과해야 한다.
- **Case-exact:** macOS case-insensitive filesystem 에서도 path segment case 가 실제 디렉토리 entry 와 정확히 맞아야 한다.
- **Traversal:** BFS 는 `README.md` 링크에서 시작하고 visited set 으로 cycle 을 끊는다. `#anchor` 와 query/hash suffix 는 파일 resolve 전에 제거한다.
- **Archive whitelist:** `results/`, `memos/`, `inbox/`, `images/`, `recordings/`, `lessons/`, `docs/` 는 per-item reachability 대상에서 제외한다. 단 각 top-level/archive folder 의 thin `README.md` 는 root topology 에서 도달 가능해야 한다.
- **Generated region freshness:** `<!-- vault-index:start/end -->` region 은 해당 폴더의 직속 child set 에서 재계산한 결과와 같아야 한다. 다르면 silent regeneration 으로 숨기지 않고 lint failure 로 보고한다.

Stale evidence age, semantic contradiction, and missing semantic cross-reference 판단은 아직 deterministic lint 가 아니라 LLM 패스 대상이다. deterministic lint 가 감지한다고 문서화하지 않는다 (No Silent Fallback).

#### L2b — Derived-view 컴파일 = `kuma vault sync`
Lint 는 drift 를 **발견**하고, `kuma vault sync` 는 그 drift 를 **재생성**한다. 두 명령은 같은 파생 규칙(`syncVaultIndex`/`buildVaultReadmeIndexUpdates` 엔진)을 공유하므로 lint 계약과 생성기 계약이 모순되지 않는다 ([architecture.md](~/.kuma/vault/architecture.md) 불변식 5·[schema.md](~/.kuma/vault/schema.md)). sync 는 한 커맨드에서 사이드카 → `--enrich`(leaf `description`) → README index → FTS `.fts/vault-fts.db` 순으로 전 파생 뷰를 content-hash idempotent 하게 컴파일한다. `--check` 는 **커밋에 들어가는 트리**에 대한 drift 게이트다: 추적 파생물(README index region·사이드카)이 어긋나면 exit 1 이고, 커밋 밖 캐시인 `.fts/vault-fts.db` 는 게이트 대상이 아니라 그 자리에서 라이브 트리로부터 재빌드된다(원칙 1 self-heal — 다른 세션의 편집이 내 커밋을 막던 원인). 재빌드는 `fts: healed` 로 보고되고 실패하면 throw 한다. stale index 감지 시 self-heal 경로도 같은 엔진으로 funnel 하며, 잔여 stale 이 남으면 조용히 넘어가지 않고 throw 한다 (No Silent Fallback). repo-agnostic — 각 트리는 루트 `vault.config.json` 자기선언이 root 와 계약을 함께 결정하므로(선언 없으면 fail-loud, 기본 볼트 fallback 없음), acme-ops 같은 다른 트리도 플래그 없이 같은 진입점으로 구동한다 ([architecture.md](~/.kuma/vault/architecture.md) "4도메인 분리").

#### L3 — LLM 패스 (의미 판정)
프로그래매틱으로 못 잡는 것은 LLM 이 돌린다. 최소 점검 항목:
- **Contradictions** — 같은 주제에 여러 페이지가 서로 다른 claim 을 할 때.
- **누락된 concept page** — 여러 페이지에서 언급되는 고유 개념이 자기 페이지 없음.
- **Missing cross-references** — A 페이지가 B 개념을 언급하는데 B 페이지로 링크 안 걸림.
- **Data gaps** — 전략·FAQ 에 "확인 필요" 남아있거나 stale 증거 주장.
- 결과는 `log.md` 에 `- LINT:` 태그로 기록하고 후속 수정 항목을 todo 화.

#### L4 — 수정은 별도 작업
Lint 는 **발견**만. 같은 패스에서 자동 수정 금지 (의미 변경 위험). 발견 → log 에 기록 → 별도 ingest/update 작업으로 처리.

## Source
- Alex direct instruction (2026-04-23) — 원문 스냅샷은 우리가 URL 로 찾은 raw data 를 `/insane-search` 로 스크랩해 보존한다.

## Related
- [architecture.md](~/.kuma/vault/architecture.md) — Kuma Topology Vault 정의·불변식.
- [schema.md](~/.kuma/vault/schema.md) — canonical slot contract / page rules.
- [info-retrieval.md](info-retrieval.md) — vault-first 조회 순서.
- kuma-vault 엔진 레포(`agent-extensions/kuma-vault`) `src/engine/vault-lint.mjs` (CLI: `vault lint`) — 프로그래매틱 lint 체커 구현. 엔진 소스 SSoT 는 kuma-vault 레포이고, kuma-studio 는 file: dep 소비자다.
- 같은 레포 `src/engine/vault-ingest.mjs` (`syncVaultIndex`) · `vault-sidecar.mjs` · `vault-enrich.mjs` · `vault-fts.mjs` · `vault-profile.mjs` · `vault-config.mjs` — `vault sync` 파생-뷰 컴파일러 엔진. 트리 계약은 각 레포 루트의 `vault.config.json` 자기선언이 소유한다.
