---
title: kuma-vault 엔진 설계 — 절단면·패키지 구조·소비 계약
type: design
created: 2026-07-04
description: Compiler Vault 엔진을 독립 배포 패키지로 추출하기 위한 설계 — 의존 절단면 전수 목록, 레포명, 패키지 구조, 배포형태, 소비 방식, provider-adapter enrich 주입 계약, 인터랙티브 셋업 골격.
---

# kuma-vault 엔진 설계 — 절단면·패키지 구조·소비 계약

> 이 문서는 `kuma-vault` 엔진의 설계 레퍼런스다. 엔진을 한 호스트 애플리케이션 안에서 독립 배포 패키지로 추출하고, 그 호스트를 배포판의 소비자로 전환하는 절단면·패키징·소비 계약을 확정한다. 배포 문서이므로 본문은 **범용 표현만** 쓴다 (특정 조직/개인 트리 사례를 예시로 들지 않는다).

## 1. 목적과 범위

Compiler Vault 엔진(frontmatter 파서 · sync · lint · search · FTS · sidecar · enrich · profile + git pre-commit 게이트 + 스킬 문서)은 호스트 애플리케이션과 독립된 **지식-베이스 컴파일러**다. 현재는 한 호스트 애플리케이션 서버 패키지의 `vault/` 디렉토리 안에 살지만, 엔진 자체는 profile 추상화로 이미 repo-agnostic 하다. 본 설계는 엔진을 **독립 배포 레포**로 추출하고, 기존 호스트를 그 배포판의 **소비자**로 전환하는 절단면·패키징·소비 계약을 확정한다.

핵심 원칙: **SSoT(엔진 소스는 신규 레포 한 곳)** · **SoC(엔진 = 순수 컴파일러, 호스트-특화 관심사는 소비자 측)** · **No Silent Fallback(vendored 복제로 두 소스 만들지 않음)**.

## 2. 의존 절단면 전수 목록 (import 그래프)

### 2.1 엔진 모듈 (프로덕션 11 + 테스트 14)

프로덕션 파일 (추출 전 호스트 위치 = 호스트 서버 패키지의 `vault/` 디렉토리):

```
vault-profile.mjs        (외부 import 0 — 순수 profile 추상화, 그래프 루트)
vault-ingest.mjs         → vault-profile
vault-search.mjs         → vault-ingest
vault-fts.mjs            → vault-search
vault-lint.mjs           → vault-ingest, vault-profile, vault-stores
vault-stores.mjs         → vault-config              (cross-store 레지스트리 로더 — docs/cross-store-pointers.md)
vault-sync-triggers.mjs  → vault-ingest, vault-lint
vault-lifecycle-hook.mjs → vault-ingest, vault-lint, vault-sync-triggers
vault-sidecar.mjs        → vault-ingest
vault-enrich.mjs         → vault-ingest              (순수 — generateDescription 주입형)
vault-enrich-adapter.mjs  → (엔진 내부 의존 없음 — provider-adapter 어댑터)
```

내부 그래프는 비순환(DAG)이며 `vault-ingest` 가 frontmatter 파서·핵심 sync 를 쥔 허브다. 루트는 `vault-profile`.

### 2.2 엔진 밖 절단면 — **7개 모듈** (airtight grep, §11 A 증빙)

프로덕션 파일이 vault 디렉토리 **밖**을 참조하는 상대 import 전수:

| # | 절단면 모듈 (현 경로) | import 심볼 | 사용 파일 | 규모/성격 | 처리 결정 |
|---|---|---|---|---|---|
| C1 | `../memo-store.mjs` | `resolveVaultDir` | enrich, fts, ingest, lifecycle-hook, lint, search, sidecar, sync-triggers (8개) | 7줄 순수 함수 (`KUMA_VAULT_DIR` env > `~/.kuma/vault`) — 863줄 패널 스토어에 얹혀 있어 **순환 유발** | **MOVE→엔진** (전용 path-resolver 모듈로 이관). 순환 절단. 호스트 memo-store 는 엔진에서 역-import |
| C2 | `../atomic-file-store.mjs` | `writeFileAtomic` | ingest | 45줄, node builtin 만 | **VENDOR→엔진** (범용 원자쓰기 프리미티브 복사) |
| C3 | `../../kuma-paths.mjs` | `DEFAULT_DISPATCH_TASK_DIR`, `DEFAULT_DISPATCH_RESULT_DIR`, `DEFAULT_VAULT_INGEST_STAMP_DIR` | ingest | 29줄, dispatch/stamp 경로 상수 | **INJECT** — dispatch-ingest 함수들의 *기본 파라미터*로만 쓰임 (§2.4). 호스트-특화 → 주입 |
| C4 | `../project-defaults.mjs` | `getConfiguredDefaultProjectId`, `inferProjectIdFromSlugPrefix`, `readPackageProjectId`, `readProjectsRegistry` | ingest | 297줄, project registry 조회 | **INJECT** — project 귀속 로직 (§2.4). 호스트-특화 → 주입 |
| C5 | `../process-util.mjs` | `normalizeCliOutput`, `runProcess` | enrich-adapter | 68줄, node `spawn` 래퍼 | **VENDOR→엔진** (provider CLI 스폰 프리미티브 — 어댑터에 동봉) |
| C6 | `../../../../shared/engine-registry.mjs` | `isKnownEngineId` | enrich-adapter | 284줄 provider registry (1개 함수만 사용) | **INLINE** — provider id 검증. 어댑터가 지원 목록(`claude`/`codex`)을 자체 보유 (§8) |
| C7 | `../team/team-config-store.mjs` | `TeamConfigStore` | enrich-adapter | 778줄 호스트 team config | **KEEP-CONSUMER-SIDE** — provider 프로파일 해석은 호스트 관심사. 엔진은 generic provider-adapter 만 export, 호스트가 주입 (§8) |

절단면은 **7개 모듈뿐**이며 §11 grep 로 실제 import 그래프와 일치함을 증빙한다. 이 중 엔진에 흡수(MOVE/VENDOR)는 C1·C2·C5, 인라인은 C6, 주입/소비자잔류는 C3·C4·C7.

### 2.3 소비 계약면 — 엔진을 **밖에서** import 하는 호스트 코드 (역방향)

엔진은 단순 "vault CLI" 가 아니라 호스트의 **공유 frontmatter 프리미티브**다. `parseFrontmatterDocument`/`stringifyFrontmatter`(vault-ingest 소재)를 재사용하는 호스트 모듈:

- `cli/vault-commands.mjs` (737줄) — vault CLI 어댑터. 엔진 8개 모듈 import (ingest/sidecar/enrich/enrich-adapter/fts/lint/profile/search) + `resolveVaultDir`.
- `server.mjs:57,187` — `runVaultLifecycleHook` (dispatch lifecycle 이벤트 → lint).
- `studio-memo-routes.mjs`, `memo-store.mjs`, `recording-store.mjs`, `dispatch/dispatch-broker.mjs`, `catalog/studio-skill-catalog.mjs`, `plan/plan-store.mjs` — 전부 `parseFrontmatterDocument`(일부 `stringifyFrontmatter`) 재사용.

**설계 함의**: 배포판은 `parseFrontmatterDocument`·`stringifyFrontmatter` 를 **public API** 로 export 해야 한다. 호스트의 6개 비-CLI 소비자가 동일 파싱 시맨틱에 의존하므로, 추출 후에도 이들은 배포 패키지에서 파서를 import 한다 (복제 금지 — SSoT).

### 2.4 core vs 호스트-특화 seam (C3·C4 근거)

`syncVaultIndex({ vaultDir, check, maxPasses, profile, trackedDirs })` (core sync 진입점)은 dispatch dir·project-defaults 를 **시그니처에 쓰지 않는다**. C3·C4 는 오직 `ingestResultFile*` · `ingestResultFileWithGuards` · `ingestInbox` · `ingestGenericSource` · `resolveResultPathForTaskId` (= **dispatch-ingest / project 귀속**)의 기본 파라미터로만 등장한다. 즉:

- **core 컴파일러** (sync/lint/search/FTS/sidecar/enrich/profile/frontmatter) = repo-agnostic, 절단면 없음(흡수분 제외).
- **dispatch-ingest + project 귀속** = 호스트-특화 슬라이스. 엔진은 이 함수들이 경로/귀속 provider 를 **주입 파라미터**로 받게 유지하고, 호스트가 자기 dispatch 경로·project registry 를 주입한다. 배포판 기본값은 no-op/undefined 로 두어 범용 트리에서 dispatch 개념 없이 동작.

## 3. 레포명 확정

**`kuma-vault`** 로 확정한다.

| 후보 | 판정 | 근거 |
|---|---|---|
| **`kuma-vault`** ✅ | 채택 | CLI 동사 `vault` · bin `kuma-vault`→`vault` 심링크 · 스킬 `kuma-vault` 와 1:1. 짧고 기존 표면과 무drift. |
| `topology-vault` | 기각 | "topology" 는 vault 내부 아키텍처 용어라 외부 소비자에게 의미 불투명. |
| `compiler-vault` | 기각 | "compiler" 성격은 정확하나 CLI/bin/스킬 어느 표면과도 매칭 안 됨 → 재네이밍 파장. |

npm 패키지명도 `kuma-vault` (레지스트리 공개는 본 plan 스코프 밖 — 로컬 배포까지만). 엔진은 profile-driven 이므로 어떤 조직/개인 트리든 "profile" 로 추상화되며, 레포명의 `kuma-` 접두는 도구 계보 브랜딩일 뿐 트리 특정성을 함의하지 않는다.

## 4. 패키지 구조 (engine / cli / hooks / skills)

**단일 npm 패키지 + 내부 SoC 디렉토리** 를 채택 (모노레포 아님 — 엔진 10파일 규모에 워크스페이스는 과설계; CLI/엔진 독립 버저닝이 필요해지면 그때 분할).

```
kuma-vault/
├─ package.json            # name: kuma-vault, type: module, engines.node >=22.5, bin: { vault, kuma-vault }
├─ bin/
│  └─ vault                # bash 진입점 (+ kuma-vault → vault 심링크). cli.mjs 로 dispatch
├─ src/
│  ├─ engine/              # 순수 컴파일러 (절단면 흡수 완료)
│  │  ├─ vault-profile.mjs
│  │  ├─ vault-ingest.mjs        # frontmatter 파서 = public API
│  │  ├─ vault-search.mjs
│  │  ├─ vault-fts.mjs
│  │  ├─ vault-lint.mjs
│  │  ├─ vault-sync-triggers.mjs
│  │  ├─ vault-lifecycle-hook.mjs
│  │  ├─ vault-sidecar.mjs
│  │  ├─ vault-enrich.mjs        # 순수, generateDescription 주입형
│  │  ├─ path-resolver.mjs       # ← C1 resolveVaultDir 이관
│  │  └─ atomic-file-store.mjs   # ← C2 vendored
│  ├─ enrich-adapters/     # provider-adapter (§8)
│  │  ├─ provider-adapter.mjs    # createCliDescriptionGenerator({ provider, model, ... })
│  │  └─ process-util.mjs        # ← C5 vendored (spawn 래퍼)
│  ├─ cli/
│  │  ├─ cli.mjs                 # vault-search|get|sync|lint|... 서브커맨드 라우터
│  │  ├─ vault-commands.mjs      # 인자 파싱 → 엔진 호출
│  │  └─ setup.mjs               # 인터랙티브 셋업 (§9)
│  └─ index.mjs            # public API 배럴 (엔진 + 파서 + 어댑터 팩토리 export)
├─ hooks/
│  └─ install-precommit.*  # git pre-commit drift 게이트 설치기 (현 bin `vault hook install` 로직 이관)
├─ skills/
│  └─ kuma-vault/          # SKILL.md + references (검색 행동 스킬)
├─ test/                   # 이관된 vitest 스위트 (12 파일)
└─ docs/
   └─ design.md            # ← 본 문서 승격 대상
```

- **index.mjs public API**: `parseFrontmatterDocument`, `stringifyFrontmatter`, `syncVaultIndex`, `lintVaultFiles`, `searchVault`/`getVaultDocuments`, `buildFtsIndex`/`checkFtsIndex`, `syncVaultSidecars`, `enrichVaultDescriptions`, `runVaultLifecycleHook`, `resolveProfile`/`VAULT_PROFILE`, `resolveVaultDir`, `createCliDescriptionGenerator`.
- 테스트는 러너 **vitest** 유지 (엔진 테스트가 `import { describe, it, expect } from "vitest"` 사용 — node:test 아님). 신규 레포에 vitest devDependency 추가.

## 5. 배포형태

**로컬 `file:` 의존 + `npm pack` tarball 아티팩트** 를 채택. **vendored 복제는 기각** (SSoT 위반 — 소스 두 벌).

- 개발: 호스트 `package.json` 에 `"kuma-vault": "file:../kuma-vault"` (또는 `npm link`). 심링크로 `node_modules/kuma-vault` 주입.
- 버전 아티팩트: `npm pack` → `kuma-vault-<x.y.z>.tgz` (이식 가능 tarball). CI/재현설치는 tarball 소비.
- 레지스트리 공개(`npm publish`)는 본 plan 스코프 밖 — 사용자 결정. 위 두 경로는 공개 없이도 성립.

이유: 엔진 소스는 `kuma-vault` 레포 한 곳(SSoT). 호스트는 `node_modules/kuma-vault` 에서 import 하므로 두 트리에 같은 코드가 물리 복제되지 않는다. `file:`/link 는 dev 편집 즉시 반영, tarball 은 고정 스냅샷 — availability failover 는 있어도 canonical 진실은 한 곳.

## 6. 호스트 애플리케이션 소비 방식

1. 엔진 디렉토리(호스트 서버 패키지의 `vault/`)를 호스트에서 **제거**, 신규 레포로 이동.
2. 호스트의 엔진 참조를 `kuma-vault` 패키지 import 로 전환:
   - `cli/vault-commands.mjs` 의 `../studio/vault/vault-*` → `kuma-vault` (배럴 또는 서브패스).
   - `server.mjs` 의 `runVaultLifecycleHook` → `kuma-vault`.
   - frontmatter 파서 6개 소비자(memo-store/studio-memo-routes/recording-store/dispatch-broker/skill-catalog/plan-store) → `kuma-vault` 에서 `parseFrontmatterDocument`/`stringifyFrontmatter` import.
3. **C1 순환 절단**: `resolveVaultDir` 이 엔진(path-resolver)으로 이동하므로, 호스트 `memo-store.mjs` 는 이를 `kuma-vault` 에서 역-import. (기존 `memo-store` → `vault-ingest` 파서 의존과 `vault-*` → `memo-store` resolveVaultDir 의존의 순환이 해소됨.)
4. **C3·C4·C7 주입**: 호스트가 dispatch 경로(C3)·project registry(C4)·provider 프로파일(C7)을 엔진 함수에 주입하는 얇은 호스트-측 와이어링 유지. dispatch-ingest 호출부는 호스트 dispatch 경로를 명시 전달.
5. 기존 CLI 계약(`kuma vault sync|lint|search|get|timeline|hook ...`) · 서버 라우트 · 전체 vitest 스위트 **무변 green** 이 소비 전환의 완료기준.

## 7. 런타임 요구사항

- **Node ≥ 22.5** — `vault-fts.mjs` 가 `node:sqlite` 의 `DatabaseSync`(FTS5) 사용. 현 호스트 `engines.node: >=20` 은 실제로 부정확(FTS 경로가 22.5+ 요구). 신규 레포 `package.json` 은 `engines.node: ">=22.5"` 로 정직하게 선언. `node:sqlite` 는 네이티브 빌드 의존 0 — zero-build 이식성 유지.
- 테스트 러너 **vitest** (devDependency).
- provider CLI(`claude`/`codex`)는 enrich 사용 시에만 런타임 PATH 요구 — core sync/lint/search/FTS 는 CLI 불요.

## 8. Provider-adapter enrich 주입 계약

enrich 엔진은 이미 순수하다: `enrichVaultDescriptions({ generateDescription, ... })` 는 write 모드에서 주입된 async `generateDescription({ relativePath, title, body }) => string` 를 요구하고, 없으면 던진다 (vault-enrich.mjs:238). 이 seam 위에 **provider-adapter** 를 표준화한다.

### 8.1 엔진 측 — generic provider-adapter (배포판 동봉)

```
createCliDescriptionGenerator({ provider, model, effort, serviceTier }) => generateDescription
```

- `provider` ∈ **`"claude"` | `"codex"`** (양쪽 지원). 지원 목록은 어댑터가 자체 보유 → C6 `isKnownEngineId` 인라인 대체.
- `provider === "codex"`: `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --cd <tmp> --model <model> --output-last-message <file>` (+ `-c model_reasoning_effort` / `service_tier` opt). 결과는 output-last-message 파일에서만 읽음 (stdout silent fallback 금지).
- `provider === "claude"`: `claude --print --output-format text --bare --no-session-persistence --dangerously-skip-permissions --model <model> <prompt>`.
- 두 경로 모두 **per-call 빈 임시 디렉토리**에서 실행 (워크스페이스 repo 아님 → 프로젝트 지시/미커밋 작업을 못 봄, 페이지 요약만). `process-util`(C5) vendored.
- 모델 기본값: `provider==="claude"` → `claude-sonnet-5`, `codex` → 범용 mini 티어. 명시 model 이 우선.

### 8.2 설치 시 provider 선택 저장

- 셋업(§9)이 선택한 `{ provider, model, effort? }` 를 **엔진 설정 파일**에 영속: `~/.kuma-vault/config.json` (env `KUMA_VAULT_CONFIG` override). SSoT = 이 파일 하나.
- CLI `vault sync --enrich` 는 설정 파일에서 `{provider, model}` 을 읽어 `createCliDescriptionGenerator` 를 구성해 주입. 설정 없으면 명시 에러(무언 기본 금지).
- **호스트 애플리케이션 특화 오버라이드**: 호스트는 자기 team-config(C7 `TeamConfigStore`)에서 provider 프로파일을 해석하는 얇은 래퍼 `createHostDescriptionGenerator({ teamConfigStore })` 를 유지하되, 내부적으로 엔진의 `createCliDescriptionGenerator` 에 위임. 즉 team-config 해석 로직은 **소비자 측**, provider 스폰 메커니즘은 **엔진 측** — 관심사 분리.
- 외부 소비자: `~/.kuma-vault/config.json` 의 `{provider, model}` 만으로 enrich 동작 (team-config 불요).

### 8.3 계약 요약

| 계층 | 소유 | 책임 |
|---|---|---|
| 순수 enrich | 엔진 `vault-enrich.mjs` | `generateDescription` 주입받아 leaf description 채움 |
| generic adapter | 엔진 `enrich-adapters/` | provider(`claude`/`codex`) CLI 스폰 → `generateDescription` 생성 |
| 설정 영속 | 엔진 config (`~/.kuma-vault/config.json`) | 설치 시 선택한 `{provider, model}` SSoT |
| 프로파일 해석 | 소비자 (호스트 team-config 등) | 자기 모델 정책 → 엔진 adapter 주입 |

## 9. 인터랙티브 플러그인형 셋업 골격

> **doc-first 근거**: 아래 트리거·표면 사실은 벤더 공식문서 daily-refresh SSoT(`skill-hook-authoring` 위키, §11 B 인용)에 기반한다.

### 9.1 셋업 표면 — 엔진 네이티브 CLI + 스킬 (host 재구현 금지)

- 셋업은 **엔진 네이티브 CLI 명령** `vault setup` (`src/cli/setup.mjs`)으로 구현하고, `node:readline/promises`(엔진 CLI 가 이미 사용 중인 인터랙티브 primitive)로 TTY 선택지를 띄운다.
- 각 런타임에는 그 런타임이 **문서화한 스킬/플러그인 표면**으로 노출:
  - **Claude Code**: 사용자-호출 스킬 = 슬래시 `/<skill-name>`; 패키지 = `.claude-plugin/plugin.json` (skills/agents/hooks/MCP 번들).
  - **Codex**: `/skills` 셀렉터 또는 `$<skill-name>` 멘션 (typed `/<skill-name>` 은 Codex 비문서형); 패키지 = `.codex-plugin/plugin.json`.
  - **portable layer** = description-triggered invocation. typed 토큰은 per-engine sugar.
- **금지(doc-first 룰)**: host GUI/터미널 레이어에서 slash surface 를 가로채 재구현하지 않는다 — 두 번째 입력 경로가 세션 컨텍스트를 재유도하고 런타임별 토큰 차이를 뭉갠다. 입력은 엔진 CLI 로 verbatim forward 하고, 능력은 skill+CLI 로 배포한다. (근거: skill-hook-authoring "Do not re-implement a slash surface in a host layer above the engine".)

### 9.2 셋업 플로우 (선택지)

1. **provider pick** — `claude` / `codex` 중 택1 (§8 어댑터와 매핑). 선택 → `~/.kuma-vault/config.json` 에 `{provider, model}` 저장.
2. **star-ask** — "이 도구가 유용하면 GitHub 에서 star 하시겠습니까? (y/N)". 동의 시 `gh` CLI 로 자동 star (`gh api --method PUT /user/starred/{owner}/{repo}` 계열). 미설치/미인증 시 조용한 실패 금지 → 명시 안내 후 skip.
3. **git hook 옵션(선택)** — 대상 repo 에 pre-commit drift 게이트 설치 여부 (hook 설치기와 연동).
- 비대화(`--yes`/CI) 모드: 모든 프롬프트를 플래그/기본값으로 대체, star-ask 는 기본 skip (동의는 명시 opt-in 이어야 함).

### 9.3 구현 범위 경계

본 §9 는 셋업 **골격(표면 선택·저장 위치·트리거 근거)** 만 확정한다. `vault setup` 실제 구현·`gh` star 명령 확정·plugin.json 생성·per-runtime 심링크 등록은 셋업 구현 단계 소관 (§10).

## 10. 경계 노트 / 후속

- **hook 패키징** = git pre-commit drift 게이트(bin `vault hook install` bash 로직). 서버 `runVaultLifecycleHook`(dispatch lifecycle lint)과는 별개 관심사 — 후자는 엔진 export 로 배포판에 포함되나 dispatch 경로는 소비자 주입(C3).
- **인터랙티브 셋업** = `vault setup` + provider pick + star-ask + `.claude-plugin`/`.codex-plugin` 메타 + 심링크 등록. doc-first 로 `gh` star·plugin.json 스키마 확정.
- **런타임 아키텍처 다이어그램**은 배포판 `docs/architecture.md` 가 SSoT (sync 파이프라인·provider-adapter·경계 트리거·검색 리졸브·멀티트리 profile).

## 11. 증거 부록

### A. 절단면 import 맵 (프로덕션 파일의 vault-dir 밖 상대 import 전수)

> 추출 전 호스트 레이아웃에서 기록한 절단면 import 맵이다. 호스트 특정 경로·파일명은 범용 표기(`<host-server-pkg>`, `vault-enrich-adapter.mjs`)로 일반화했고, 아키텍처 주장(어느 모듈이 어느 절단면 C1~C7 을 import 하는지)은 그대로 보존된다.

```
$ cd <host-server-pkg>/vault   # 추출 전 호스트 위치
$ for f in $(ls *.mjs | grep -v '\.test\.mjs$'); do grep -HnE 'from "\.\./' "$f"; done
vault-enrich-adapter.mjs:17: from "../process-util.mjs"            # C5
vault-enrich-adapter.mjs:18: from "../../../../shared/engine-registry.mjs"  # C6
vault-enrich-adapter.mjs:19: from "../team/team-config-store.mjs"  # C7
vault-enrich.mjs:30:        from "../memo-store.mjs"              # C1
vault-fts.mjs:32:           from "../memo-store.mjs"              # C1
vault-ingest.mjs:7:         from "../../kuma-paths.mjs"           # C3
vault-ingest.mjs:8:         from "../memo-store.mjs"              # C1
vault-ingest.mjs:9:         from "../atomic-file-store.mjs"       # C2
vault-ingest.mjs:16:        from "../project-defaults.mjs"        # C4
vault-lifecycle-hook.mjs:7: from "../memo-store.mjs"              # C1
vault-lint.mjs:5:           from "../memo-store.mjs"              # C1
vault-search.mjs:5:         from "../memo-store.mjs"              # C1
vault-sidecar.mjs:27:       from "../memo-store.mjs"              # C1
vault-sync-triggers.mjs:24: from "../memo-store.mjs"              # C1
```

→ 절단면 = **C1~C7 7개 모듈** (그 외 상대 import 는 전부 `./vault-*` 엔진 내부). §2.2 표와 1:1 일치.

### B. doc-first 인용 (인터랙티브 셋업 트리거)

출처: `skill-hook-authoring/SKILL.md` (벤더 공식문서 daily-refresh, "Every claim cites the vendor's own docs").
- Claude Code: 스킬 = `/<skill-name>` 슬래시, `disable-model-invocation: true` = explicit-only; 패키지 = `.claude-plugin/plugin.json`.
- Codex: `/skills` 셀렉터 · `$<skill-name>` 멘션; 패키지 = `.codex-plugin/plugin.json`.
- portable = description-triggered invocation.
- 룰: host 레이어에서 slash surface 재구현 금지 → 엔진 CLI+skill 로 forward.
- Cross-Agent Install Pattern: canonical repo path + 런타임 문서형 user skill root 로 심링크 + generated config.

### C. 핵심 코드 좌표

- `resolveVaultDir` 정의: `memo-store.mjs:120-126` (7줄 순수).
- enrich 주입 시그니처: `vault-enrich.mjs:231-239` (`generateDescription` 없으면 write 모드 throw).
- provider 어댑터: `vault-enrich-adapter.mjs` (헤더 주석: "It lives outside the engine so the engine stays process-free").
- CLI 주입 와이어: `cli/vault-commands.mjs:635-641` (`createHostDescriptionGenerator()` → `enrichVaultDescriptions`).
- FTS sqlite: `vault-fts.mjs:29` (`import { DatabaseSync } from "node:sqlite"`).
- underscore-bucket lint 면제: `vault-lint.mjs:852,940` · `vault-ingest.mjs:1194-1201`.
