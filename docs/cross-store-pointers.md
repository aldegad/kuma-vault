# Cross-store 포인터 lint 계약

`vault lint` 는 문서 본문의 cross-store 포인터를 검출해 대상 저장소의 실제 파일 존재로 해소 검사를 수행하고, 미해소는 명시 실패로 보고한다. 규약 자체(형식·의미·방향)의 owner 는 각 트리 `schema.md` "Cross-store 포인터" 절이며, 이 문서는 엔진이 그 규약을 기계 검증하는 방식만 규정한다.

## 포인터 형식

cross-store 포인터는 인라인 백틱 코드 스팬 안의 토큰 `` `<store-id>:<저장소-상대-경로>` `` 이다. `store-id` 는 대상 트리 `vault.config.json` 의 `id` (예: `kuma-brain`, `acme-ops`), 경로는 그 트리 루트 기준 상대 경로다. 디렉터리를 가리킬 때는 후행 슬래시를 붙인다 (예: `` `kuma-brain:domains/research/pqc/` ``).

## store-id -> 루트 매핑: 머신-로컬 레지스트리

같은 논리 store 는 머신마다 다른 절대 경로에 산다. 따라서 `id -> 루트 경로` 매핑은 본질적으로 머신-로컬 관심사이며 어느 트리에도 담을 수 없다. 이 매핑의 SSoT 는 머신-로컬 레지스트리 파일이다.

- 기본 경로: `~/.kuma/vault-stores.json` (`$KUMA_HOME_DIR/vault-stores.json`). `KUMA_VAULT_STORES` 환경변수로 override 한다.
- 형식: `{ "stores": { "<store-id>": "<절대 경로 또는 ~ 기준 경로>" } }`.
- `store-id` 자체의 owner 는 여전히 각 트리 `vault.config.json` 의 `id` 다. 레지스트리는 `id -> 루트`만 소유한다. 해소 시 엔진은 등록된 루트의 `vault.config.json` `id` 가 그 store-id 와 실제로 일치하는지 검증한다 (consistency self-heal). 불일치는 loud fail 이다.

레지스트리 생성이 곧 이 검사의 opt-in 이다. 레지스트리가 없는 머신(다른 사용자 환경)에서는 포인터를 해소하지 않되, 조용히 통과시키지 않고 명시적으로 skip 을 리포트한다.

## 검출 경계 (오탐 정의)

한 토큰이 cross-store 포인터로 인정되려면 전부 만족해야 한다.

- 단일 백틱 인라인 코드 스팬 안에 있고, 스팬 내용 전체가 `<store-id>:<경로>` 다. fenced code block(```` ``` ````, `~~~`) 안의 토큰은 예시로 간주해 검사하지 않는다.
- `store-id` 가 소문자 케밥 문법 `[a-z][a-z0-9]*(-[a-z0-9]+)*` 에 맞는다.
- 경로가 `/` 로 시작하지 않는다 (머신 절대 경로는 cross-store 참조가 아니다).
- 경로에 `://` 가 없다.
- 경로가 vault 문서 참조다: `.md` (마크다운 페이지)로 끝나거나 `/` (디렉터리)로 끝난다. cross-store 포인터는 다른 트리의 문서를 가리키는 것이므로 이 shape 는 휴리스틱이 아니라 규약 자체다.

이 경계는 값이 우연히 경로처럼 보이는 메일 헤더·URI 스킴을 배제한다: `to:alex@x.app`, `from:host.com`, `forward:y@gmail.com`, `file:../x`, `data:image/png;base64,...`. URL(`https://...`), 시각·비율 텍스트(`16:9`, `12:30`), 일반 `key: value` 콜론도 배제된다. (실측에서 실제로 검출된 오탐 클래스다.) 디렉터리를 가리키려면 반드시 후행 슬래시를 붙인다.

## 실패 코드

해소되지 않은 포인터는 구조화된 코드로 보고한다. 모두 `severity: error` 이며 lint 를 실패시킨다.

| code | 의미 |
|---|---|
| `cross-store-unknown-store` | store-id 가 레지스트리에 없다. 등록하거나 store-id 오타를 고친다. |
| `cross-store-store-root-missing` | 레지스트리에 등록됐지만 그 루트가 이 머신에 없다. |
| `cross-store-registry-mismatch` | 등록 루트의 트리가 다른 `id` 를 선언한다 (레지스트리와 트리 자기선언 불일치). |
| `cross-store-registry-invalid` | 레지스트리 파일이 존재하나 JSON 이 깨졌거나 형식이 틀렸다. 포인터는 이때 해소하지 않는다. |
| `cross-store-pointer-invalid` | 경로가 `..` 로 대상 store 루트를 벗어난다. |
| `cross-store-pointer-unresolved` | store 는 해소됐으나 대상 파일(또는 후행 슬래시면 디렉터리)이 존재하지 않는다. |

레지스트리가 아예 없는 머신에서 포인터가 하나라도 발견되면 `cross-store-check-skipped` 를 `severity: warn` 으로 한 줄 리포트한다 (카운트 포함). warn 은 리포트되되 lint 를 실패시키지 않는다.

## severity 와 리포트

lint issue 는 `severity` 를 가진다. 명시하지 않은 issue 는 `error` 로 취급하며(기존 모든 검사), `result.ok` 는 error-severity issue 가 하나도 없을 때만 true 다. `warn`/`info` issue 는 리포트되지만 lint 를 실패시키지 않는다. 텍스트 리포트는 warn 을 `[warn]` 마커로 출력한다.

## 실행 위치

이 검사는 `full` 모드에서만 실행된다. 요청된 파일 집합(전수 트리 walk 또는 명시 `--files` 부분집합)을 순회하므로, pre-commit 경로에서 변경된 파일 하나에 새로 생긴 깨진 포인터도 잡힌다. `fast` 모드는 peer 트리 파일시스템 해소를 하지 않는다. 전수 walk 는 archive·plans slot·owner-local bucket 을 이미 제외하므로 역사 문서의 stale 포인터로 인한 오탐이 없다.

구현: `src/engine/vault-stores.mjs` (레지스트리 로더·검증), `src/engine/vault-lint.mjs` (파서·해소 스캔). 테스트: `src/engine/vault-stores.test.mjs`, `src/engine/vault-cross-store.test.mjs`.

## 소비자: vault graph 의 xstore 레이어

`vault graph` 는 같은 파서(`extractCrossStorePointers`)와 같은 레지스트리로 **xstore 레이어**를 그린다 — 참조 문서 → 외부 문서 노드 → 외부 store 허브. 파서와 오탐 경계의 owner 는 계속 이 lint 쪽 구현 하나다(그래프는 자체 파서를 갖지 않는다). 그래프는 검증자가 아니라 뷰어이므로 미등록 store-id 는 fail 대신 카운트로만 보고하고, 스캔된 store(자기 자신 포함, `--all-stores` union 모드에선 등록 store 전부)로 향하는 포인터는 외부 노드를 만들지 않고 그 store 의 실제 문서 노드로 해소한다 — union 뷰에서 이 엣지가 store 간 실제 탐색 다리(bridge)다. 상세: `skills/kuma-vault/docs/graph.md`.
