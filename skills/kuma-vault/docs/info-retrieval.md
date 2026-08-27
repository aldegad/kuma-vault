# Information Retrieval Order

## Summary
쿠마가 **사실·지식·인용·개념 설명을 요구받을 때** 의 정보 조회 순서는 고정이다. vault 우선, 외부 검색은 vault 에 없을 때만. 기억이나 추정으로 단언 금지.

### Why
쿠마는 amnesiac 전제로 동작한다. 모델 weight 에 녹아있는 지식은 출처 검증 없이 꺼내면 할루시네이션 위험이 크다 (실제로 2026-04-23 세션에서 Haraway ↔ Nagel 혼동, Aristotle 인용 과잉 대입 등 발생). canonical 지식은 vault 에 있고, vault 에 없으면 외부 1차 소스로 실시간 확인해야 한다.

### How to apply
모든 사실형 질의에 대해 아래 순서를 그대로 따른다. 순서를 건너뛰고 기억에서 답하지 않는다.

## Rules

### R1 — 정보 조회 순서 (고정)

1. **Vault 조회 (L1 → L2 → L3)**
   - `vault search <q>` 로 hits 확인 (L1)
   - 매칭이 보이면 `vault timeline <q>` 로 주변 스니펫 확인 (L2)
   - 해당 문서 지목되면 `vault get <path>` 로 전문 로드 (L3)
   - 이 조회 엔진은 vault tree 를 직접 걷는다. root/folder README topology 는 사람이 탐색하고 lint 가 reachability 를 검증하는 진입점이며, `search → timeline → get` 순서는 바뀌지 않는다.
   - 이 단계에서 답이 나오면 끝. 외부 검색으로 넘어가지 않는다.
2. **외부 웹 검색 (vault 에 없을 때만)**
   - 기본은 `WebSearch` / `WebFetch`.
   - 블록·WAF·차단 사이트거나 소셜 플랫폼(X/Twitter, Threads, Reddit, Naver blog 등)이면 **insane-search** 스킬 사용.
   - 검색 결과를 답변에 인용할 때는 URL·저자·연도를 함께 명기한다.
3. **출처 확인 불가 시**
   - "모른다" 또는 "확인 필요" 로 답한다. 추정·기억으로 단언하지 않는다.
   - 필요하면 사용자에게 추가 힌트를 요청한다.

### R2 — 새로 확인한 사실은 vault 로 승격 고려
- 외부에서 확인된 사실이 재사용될 만하면 `domains/` 또는 `learnings/` 로 ingest 한다 (archive-first, canonical 승격은 명시적으로).
- 특히 철학·역사·인물·전문 분야 인용은 `domains/engineering/philosophy-reference.md` 같은 출처 확정 페이지에 append 한다. 저자·저작·연도 3요소 확인 규칙 유지.

### R3 — 사실형·논지형이 아닌 질의
- 코드 수정, 디자인 판단, 유저와의 가벼운 자유 대화는 R1·R5 대상이 아니다.
- 다만 유저가 "그거 출처 뭐야", "정확한 용어 뭐야" 같이 사실형 질문을 섞으면 그 부분만 R1 을 적용한다.

### R4 — 할루시네이션 체크 지점
- 쿠마가 "아마", "대략", "~인 걸로 기억" 같은 표현을 쓰고 있으면 **이미 R1 을 건너뛴 상태**다. 그 시점에 vault 조회 또는 외부 검색으로 전환한다.
- 전문 인용을 단언할 때는 최소 **저자 + 저작명** 중 하나라도 vault/외부에서 확인돼야 한다.

### R5 — 논지·의견·주장형 질의 트리거

알렉스가 "어떻게 생각해", "내 생각엔 X 인데 너는?", "이거 맞아?", "~에 대한 의견", "철학적으로 어때" 같은 발화를 던지면 그 자리에서 즉답하지 말고 다음 순서를 거친다.

1. **vault 철학·도메인 우선 조회**
   - `~/.kuma/vault/domains/engineering/philosophy-reference.md` 에서 관련 인물·개념·인용 카드 확인.
   - 주제와 매칭되는 `domains/<topic>.md` (예: `model-frontier.md`, `analytics.md`) 도 함께 로드.
   - 알렉스가 이전에 이 주제로 내린 결정·선호가 `decisions.md` 또는 `projects/*.project-decisions.md` 에 있는지 확인.
2. **확장 사고로 응답**
   - 단편 답이 아니라 vault 에서 끌어온 어휘·인용·이전 결정을 기반으로 입체 답변.
   - 알렉스 vocabulary (예: "thin core / thin adapter", "no academic over-attribution") 를 우선 활용.
3. **새 사실은 R2 처럼 vault 승격 고려**
   - 응답 중 알렉스가 새로 가르쳐준 입장·주장은 적절한 vault 페이지에 ingest 후보로 표시.

R5 가 R1 (사실형) 과 다른 점: R1 은 "정답 찾기", R5 는 "맥락 갖춘 입체 응답". 둘 다 vault 우선이지만 출력 형태가 다르다.

#### 안티패턴
- ❌ vault 안 보고 모델 weight 만으로 의견 작성 ("AI slop" 의 전형).
- ❌ 알렉스 vocabulary 무시하고 일반론 답.
- ❌ 사실형 질의처럼 "출처 + 정의" 만 던지고 끝 (R5 는 입체 응답이 본질).

## Source
- Alex direct instruction (2026-04-23, 하네스 엔지니어링 담론 정리 중 쿠마 할루시네이션 발생 후)

## Related
- [philosophy-reference.md](~/.kuma/vault/domains/engineering/philosophy-reference.md) — 철학 인용 canonical 목록
