---
name: kuma-vault-remote-backup
description: 'Set up and operate client-encrypted offsite backup for a kuma-vault knowledge repo (or any local-only git repo holding secrets) using restic to S3-compatible storage such as Cloudflare R2. Use when a vault/repo has no git remote by policy but needs disaster durability, when asked to back up the brain/vault to the cloud, to verify or restore a backup, or to decide where backup keys must live. Triggers (KR/EN): 볼트 백업, 브레인 백업, 원격 저장, 클라우드 백업, 암호화 백업, R2 백업, restic, 백업 복원, 백업 검증, 백업 키 어디에, back up the vault, encrypted offsite backup, restore the backup, remote storage guide.'
user-invocable: true
---

# kuma-vault-remote-backup — 암호화 원격 백업 가이드

원격(github 등)을 두지 않기로 한 지식 레포의 내구성을 담당하는 표준 패턴:
**로컬 git (히스토리) + restic 클라이언트 암호화 → S3 호환 스토리지 (암호문만)**.
비밀·개인정보 원문을 정제 없이 통째로 보존하면서 디스크 사망에 대비한다.

실제 지식 레포들에 적용하며 측정된 절차다.

## 왜 이 조합인가

- **원격 git 은 평문 노출** — private repo 도 실수 공개·토큰 유출 한 방의 블라스트 반경이 "뇌 전체"다. 비밀값을 빼고 커밋하는 정책은 원문을 오염시켜 SSoT 를 해친다.
- **restic**: 콘텐츠 단위 청킹 + 중복제거 + 클라이언트 암호화. 스냅샷마다 완전 복원점인데 저장은 변경 청크만 (수 GiB 레포도 2회차 스냅샷은 수 초). `.git` 을 포함한 폴더 전체를 그냥 파일로 백업하므로 git 히스토리가 통째로 보존된다 — restic 은 git 을 모르고, 알 필요도 없다.
- **Cloudflare R2**: 이그레스 무료(복원 0원), 무료 구간 10 GB-월. 다른 S3 호환도 가능 — restic 쪽은 endpoint 만 다르다.

## 셋업 절차

1. **버킷 + S3 토큰**: 스토리지 콘솔에서 레포당 버킷 1개, Object Read&Write 를 그 버킷 한정으로 발급.2. **자격증명은 OS 키체인으로만**: `security add-generic-password -s <repo>-restic-r2 -a access-key-id|secret-access-key|endpoint`. 시크릿이 1회 노출되는 발급 화면은 셸 변수로 받아 키체인 직행 — **대화 로그·파일에 값을 찍지 않는다** (마스킹 출력만).
3. **restic 패스워드**: 생성 → 키체인 `-s <repo>-restic -a password` + 볼트 문서(재해 절차 포함) 저장.
4. **init + 첫 백업**:

   ```bash
   export AWS_ACCESS_KEY_ID=$(security find-generic-password -s <repo>-restic-r2 -a access-key-id -w)
   export AWS_SECRET_ACCESS_KEY=$(security find-generic-password -s <repo>-restic-r2 -a secret-access-key -w)
   export RESTIC_PASSWORD=$(security find-generic-password -s <repo>-restic -a password -w)
   EP=$(security find-generic-password -s <repo>-restic-r2 -a endpoint -w)
   restic -r "s3:$EP/<bucket>" init
   restic -r "s3:$EP/<bucket>" backup <repo-path> \
     --exclude "**/node_modules" --exclude "**/.venv" --exclude "**/__pycache__" \
     --exclude "/.fts" --exclude "**/*.log" --exclude ".DS_Store" --exclude "tmp/"
   ```

   파생물(FTS 인덱스·빌드물·캐시)은 백업하지 않는다 — `vault sync` 등이 재생성한다 (SSoT 원칙).
5. **정기 실행**: 러너 스크립트(키체인에서 읽기 + backup + `forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune` + `snapshots --latest 1` 출력) 를 야간 cron 에 건다. 실패는 조용히 넘기지 말고 관측 가능하게 보고.

## 열쇠 배치 — 순환 참조를 반드시 끊는다

**백업 대상 머신 위의 패스워드 사본(키체인·볼트 문서)은 그 머신과 함께 죽는다.**
볼트 문서의 사본은 암호화된 백업 *안에* 들어가므로 재해 시엔 열 수 없는 금고 속 열쇠다.

- restic 패스워드: **오프머신 사본 1부가 필수** (폰 비밀번호 관리자, `adb push` 한 파일, 종이 — 형태 무관). 이거 없으면 백업은 "있는데 못 여는" 상태로 재해 당일 발견된다. 메신저 전송은 평문이 서버에 남으므로 비추.
- S3 토큰: **재발급이 싸다** — 키체인만으로 충분, 오프머신 불필요 (재해 시 콘솔에서 새로 발급).
- 성립 조건 = **삼각형**: R2 의 암호문 + 오프머신 패스워드 + 재발급 가능한 토큰.

## 검증 — 스냅샷 id 는 성공의 증거가 아니다

성공 판정은 **다른 디렉토리로 실제 복원해서 그 복원본의 `git log` 가 도는 것**으로 한다:

```bash
restic -r "s3:$EP/<bucket>" restore latest --target /tmp/verify --include "<repo-path>/.git"
git --git-dir=/tmp/verify/<repo-path>/.git log --oneline -3   # 최신 커밋까지 보여야 통과
```

복원 검증은 키체인에서 읽은 패스워드로 수행한다 (사본이 실제로 여는 열쇠인지까지 검증).
파일 하나를 원본과 `cmp` 로 바이트 대조하면 더 강하다. 검증 후 scratch 는 삭제.

## 복원 (재해 시, 다른 머신에서)

1. 스토리지 콘솔 로그인 → 새 S3 토큰 발급 (Object Read, 해당 버킷)
2. `RESTIC_PASSWORD=<오프머신 사본> restic -r "s3:<endpoint>/<bucket>" restore latest --target ~/restore`
3. 복원된 폴더의 `.git` 이 그대로 살아 있다 — clone 이 아니라 원본 복귀다.
