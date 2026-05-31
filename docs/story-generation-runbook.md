# Story Generation Runbook

이 문서는 여러 편의 기존 고전/전래 기반 이야기를 한 번에 추가할 때 따르는 운영 절차를 정리한다. `scripts/story-pipeline.mjs`를 사용한 자동 생성, 생성 후 검증, 리뷰에서 나온 문제를 어떻게 처리할지까지 포함한다.

관련 상세 명세는 다음 문서를 함께 본다.
- `docs/cli-content-pipeline.md`: 자동 생성 CLI의 옵션과 파이프라인 구조
- `docs/manual-story-generation.md`: 수동 생성 또는 수동 보강 시 지켜야 할 계획/초안/검토 기준
- `docs/content-model.md`: `content/stories.yml`과 `content/versions/*.md`의 데이터 모델

## 1. 생성 전 준비

### 1.1 현재 콘텐츠 확인

새 이야기를 제안하거나 생성하기 전에 현재 리포의 콘텐츠 목록을 먼저 확인한다.

```bash
rg -n "^  story_|title:|versions:" content/stories.yml
rg --files content/versions
```

확인할 내용:
- 같은 원전/같은 slug가 이미 있는지
- 같은 이야기가 다른 연령/길이 버전으로 이미 존재하는지
- 새로 만들 story id와 version id가 기존 흐름과 충돌하지 않는지
- 기존 태그 풀에서 사용할 수 있는 태그인지

### 1.2 후보 선정

새 후보는 되도록 기존에 널리 알려진 고전, 전래, 신화, 설화, 공개 도메인 원전을 우선한다. 완전 창작은 사용자가 명시적으로 원할 때만 선택한다.

후보를 정할 때는 각 항목마다 다음을 미리 기록한다.
- 제목
- slug
- 원전명 또는 source
- 대상 연령대
- length
- 시리즈라면 episodes
- tags
- 핵심 사건 목록
- 안전 완화가 필요한 지점

### 1.3 길이 선택

길이는 연령대가 아니라 원전의 필수 사건량과 압축 손실을 기준으로 고른다.

- `short`: 하나의 사건/반전/감정 변화만 있는 짧은 우화
- `medium`: 필수 장면이 2개 안팎인 단순한 단편
- `long`: 필수 장면이 3~5개이지만 한 번에 읽는 단편으로 유지 가능한 이야기
- `short_series`: 3~4개의 자연스러운 회차 전환점이 있는 이야기
- `long_series`: 장편 원전, 긴 여정, 반복 시련, 역사/종교/신화 서사처럼 5화 이상이 자연스러운 이야기

유명 원전 전체를 담으면서 `medium`을 기본값처럼 쓰지 않는다. 6-7세 대상이어도 원전 핵심 장면이 많으면 `long` 또는 `short_series` 이상으로 올리고, 문장 난이도만 낮춘다.

## 2. 생성 실행

### 2.1 기본 모델

현재 기본 Gemini 모델은 `gemini-3.5-flash`다. `scripts/story-pipeline.mjs`의 `DEFAULT_MODEL`에서 확인할 수 있다.

```bash
rg -n "DEFAULT_MODEL|--model" scripts/story-pipeline.mjs
```

모델 선택 기준:
- 기본 대량 생성: `gemini-3.5-flash`
- 품질 우선 실험: 사용 가능한 최신 Pro 계열 모델을 명시
- fallback이 필요할 때: `--model`로 다른 provider 모델을 지정하되, 결과물의 `pipeline_version`과 meta model을 나중에 반드시 기록한다

### 2.2 생성 명령

한 번에 하나씩 생성한다. 생성이 수십 분 걸릴 수 있으므로, 병렬 실행하지 않는다.

단편:
```bash
npm run generate:story -- \
  --title "빌헬름 텔" \
  --story-title "빌헬름 텔" \
  --source "빌헬름 텔" \
  --age "6-7" \
  --length "long" \
  --slug "william-tell" \
  --tags "고전각색,용기,가족,정의,역경"
```

시리즈:
```bash
npm run generate:story -- \
  --title "모세 이야기" \
  --story-title "모세 이야기" \
  --source "모세 이야기" \
  --age "6-7" \
  --length "long_series" \
  --episodes "5" \
  --slug "moses" \
  --tags "고전각색,가족,용기,소명,역경"
```

기존 파일을 같은 id로 재생성할 때는 `--story-id`, `--slug`, `--age`, `--length`, `--overwrite`를 함께 사용한다. 이렇게 하면 기존 Markdown frontmatter의 `story_id`와 version id를 보존할 수 있다.

```bash
npm run generate:story -- \
  --title "이카로스" \
  --story-title "이카로스" \
  --story-id "story_103" \
  --source "이카로스" \
  --age "6-7" \
  --length "long" \
  --slug "icarus" \
  --tags "고전각색,모험,약속,성장,지혜" \
  --model "gemini-3.5-flash" \
  --overwrite
```

### 2.3 생성 직후 확인

각 항목 생성 직후 최소한 다음을 확인한다.

```bash
npm run validate:content
```

확인할 내용:
- 새 Markdown 파일이 `content/versions/<slug>__<age>__<length>.md` 형태로 생성됐는지
- `content/stories.yml`에 새 `story_###`와 `ver_###_01`이 연결됐는지
- `pipeline/meta/<slug>__<age>__<length>.json`이 생성됐는지
- 시리즈의 회차 수가 요청한 범위와 맞는지
- 요약에 "버전", "낭독용", "시리즈 제작" 같은 제작 메타데이터가 섞이지 않았는지

## 3. 운영상 Takeaways

### 3.1 생성은 한 편씩 끝까지 확인한다

한 편 생성이 오래 걸릴 수 있으므로 여러 편을 병렬로 생성하지 않는다. 한 편을 생성한 뒤 `npm run validate:content`를 통과시키고 다음 편으로 넘어간다. 실패가 발생해도 이미 성공한 파일은 되돌리지 않는다.

권장 흐름:
1. 한 편 생성
2. 생성 로그에서 output path, story id, version id 확인
3. `npm run validate:content`
4. 실패했다면 같은 항목을 재시도하거나 직접 수정
5. 다음 항목 진행

### 3.2 일시적 API 오류는 먼저 같은 명령으로 재시도한다

네트워크 오류, 429, retry delay, 일시 capacity 오류가 발생하면 기본 대응은 **같은 명령을 다시 실행하는 것**이다. quota가 충분해 보여도 모델별 분당 요청 수, 분당 토큰 수, 일일 요청 수, 일시 capacity 제한 중 하나로 실패할 수 있다.

재시도 기준:
- 첫 실패: 같은 명령으로 1회 재시도
- 같은 오류가 반복됨: 잠시 기다린 뒤 같은 명령으로 1회 더 재시도
- 세 번째도 실패: 그 항목은 보류하고 다음 항목으로 넘어가거나, 사용자가 승인한 다른 모델을 명시한다

모델을 바꿔 생성한 경우에는 나중에 반드시 다음을 확인한다.
- Markdown frontmatter의 `pipeline_version`
- meta JSON의 `"model"`
- 같은 batch 안에서 모델이 섞인 이유
- 필요하다면 같은 모델로 다시 `--overwrite` 재생성할지 여부

### 3.3 재생성할 때는 id 보존이 우선이다

이미 `content/stories.yml`에 들어간 항목을 다시 생성할 때는 새 story/version을 만들지 않는다. 기존 id를 유지하기 위해 `--story-id`, `--slug`, `--age`, `--length`, `--overwrite`를 함께 사용한다.

예시:
```bash
npm run generate:story -- \
  --title "이카로스" \
  --story-title "이카로스" \
  --story-id "story_103" \
  --source "이카로스" \
  --age "6-7" \
  --length "long" \
  --slug "icarus" \
  --tags "고전각색,모험,약속,성장,지혜" \
  --model "gemini-3.5-flash" \
  --overwrite
```

### 3.4 재생성 프롬프트에는 빠진 사건을 명시한다

품질 리뷰에서 원전 핵심 사건 누락이 발견되면 단순히 같은 명령을 반복하지 않는다. `--synopsis`에 누락된 핵심 사건과 안전 완화 방향을 명시하고 1회 재생성한다.

예시:
```bash
npm run generate:story -- \
  --title "빌헬름 텔" \
  --story-title "빌헬름 텔" \
  --story-id "story_108" \
  --source "빌헬름 텔" \
  --synopsis "사과 맞히기뿐 아니라 두 번째 화살, 체포, 폭풍 속 탈출, 게슬러와의 최종 대립까지 포함하되 6-7세에게 과격하지 않게 각색한다." \
  --age "6-7" \
  --length "long" \
  --slug "william-tell" \
  --tags "고전각색,용기,가족,정의,역경" \
  --model "gemini-3.5-flash" \
  --overwrite
```

1회 재생성 후에도 같은 문제가 남으면 무한 재생성하지 않는다. 그 항목은 이번 커밋에서 제외하고, 필요한 경우 별도 작업으로 length 조정이나 coverage scope 재정의를 다시 논의한다.

## 4. 리뷰 절차

생성 완료 후 리뷰는 기계적 검증과 에이전트가 읽는 품질 검토를 분리한다.

### 4.1 기계적 검증

기본 검증:
```bash
npm run validate:content
npm test
npm run build
```

추가로 표를 뽑아 이상치를 확인한다.

```bash
node -e '
const fs=require("fs");
const files=fs.readdirSync("content/versions").filter((f)=>f.endsWith(".md"));
for (const f of files) {
  const s=fs.readFileSync("content/versions/"+f,"utf8");
  const fm=s.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const body=s.slice(s.indexOf("\n---\n")+5);
  const get=(k)=>(fm.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`,"m"))||[])[1]||"";
  const chapters=(body.match(/^###\s+\d+화/gm)||[]).length;
  const chapterTimes=(body.match(/^- estimated_read_time:/gm)||[]).length;
  console.log([get("id"), get("story_id"), get("title"), get("age_range"), get("length_type"), get("pipeline_version"), get("estimated_read_time"), get("actual_char_count"), chapters, chapterTimes, f].join("\t"));
}
'
```

확인할 내용:
- required frontmatter 존재 여부
- 파일명과 `age_range`, `length_type` 일치
- `story_id`와 version id가 `content/stories.yml`과 일치
- `pipeline_version`이 의도한 모델 계열과 일치
- series 회차 수와 회차별 `estimated_read_time` 존재 여부
- frontmatter의 총 `estimated_read_time`과 회차별 읽기 시간 합산이 크게 어긋나지 않는지
- `actual_char_count`가 length 기준에서 과도하게 짧거나 긴지

### 4.2 품질 리뷰

품질 리뷰는 최소 두 관점으로 나눠서 본다.

구조/메타 리뷰:
- frontmatter 필드
- `content/stories.yml` 연결
- filename 규칙
- 태그 유효성
- 시리즈 회차 구조
- model/pipeline 표기

본문 품질 리뷰:
- 한국어 문장이 자연스러운지
- 연령대에 맞는 표현인지
- 원전의 핵심 사건을 유지하는지
- 안전 완화가 사건 구조를 지나치게 바꾸지 않았는지
- 요약과 본문 결말이 서로 맞는지
- 본문이 중간에 끊기지 않았는지
- 시리즈 회차별 전환점이 자연스러운지

괄호 감정 표현은 무조건 오류로 보지 않는다. `(조용히)`처럼 대사 바로 앞에서 감정이나 말투를 짧게 지시하는 표현은 허용한다. 다만 `[SFX]`, `[Pause]`, "낭독자:", "제작 메모:" 같은 오디오/제작 지시문은 제거한다.

### 4.3 Subagent 리뷰 분담

subagent를 사용할 수 있는 환경에서는 리뷰를 병렬로 나눈다. 각 subagent는 read-only로 실행하고, 파일을 직접 수정하지 않게 한다.

권장 분담:
- 구조/메타 리뷰 agent: `story_###` 범위, frontmatter, `content/stories.yml` 연결, filename 규칙, 태그, 회차 수, 읽기 시간, model/pipeline 표기 확인
- 품질 리뷰 agent A: 배치의 앞쪽 절반 또는 3-5/6-7세 중심 파일의 한국어 문장, 연령 적합성, 원전 핵심 사건, 요약/본문 일치 여부 확인
- 품질 리뷰 agent B: 배치의 뒤쪽 절반 또는 8-9세/long_series/원전 위험도가 높은 파일의 한국어 문장, 연령 적합성, 원전 핵심 사건, 요약/본문 일치 여부 확인

배치가 작으면 구조/메타 리뷰와 품질 리뷰 하나만 둬도 충분하다. 배치가 크면 단순히 생성 순서 기준으로 반씩 나누거나, 더 위험한 항목을 따로 묶는다.

위험도가 높은 항목 예시:
- 원전 결말이 비극적인 이야기
- 종교/역사/신화처럼 핵심 사건 누락이 생기기 쉬운 이야기
- 폭력/공포 묘사를 안전하게 완화해야 하는 이야기
- 장편 원전인데 단편 `long`으로 압축한 이야기

구조/메타 리뷰 프롬프트 예시:
```text
Read-only review only; do not edit files. Review structural/content metadata correctness for the generated story files and content/stories.yml entries story_089 through story_108. Focus on required frontmatter, story_id/version id consistency, filename age/length matching frontmatter, expected pipeline_version, series chapter counts and estimated_read_time lines, tags validity if locally checkable, and whether content/stories.yml references all versions. Return concise findings with file paths and line references for any issue; say clearly if no issues found.
```

품질 리뷰 프롬프트 예시:
```text
Read-only review only; do not edit files. Review content quality for the assigned generated stories. Focus on Korean prose integrity, age appropriateness, source/core-event preservation, no production metadata in summary/prose, no obvious truncation or malformed headings, and whether the length choice seems plausible for the story. Return concise findings with file paths and line references for any issue; say clearly if no issues found.
```

리뷰 결과를 받을 때는 findings를 그대로 수정 목록으로 확정하지 않는다. 다음 기준으로 한 번 더 분류한다.
- 기계적 오류: 직접 수정
- 원전 핵심 누락: 1회 재생성 우선
- 안전 완화 범위 안의 각색: 유지 가능
- 취향 차이 또는 허용된 표현: 수정하지 않음

## 5. 리뷰 결과 대응 원칙

### 5.1 직접 수정하는 문제

다음은 재생성하지 않고 담당 에이전트가 직접 수정한다.
- 단순 오타
- 조사/띄어쓰기/문장부호 오류
- 직접화법 따옴표 누락
- frontmatter `estimated_read_time`과 회차별 읽기 시간 합산 불일치
- 요약의 단어 하나가 본문과 사소하게 어긋나는 경우
- 허용 태그 누락 또는 순서 정리

직접 수정 후 반드시 실행한다.

```bash
npm run validate:content
```

문서나 코드가 같이 바뀐 경우:
```bash
npm test
npm run build
```

### 5.2 재생성을 먼저 시도하는 문제

다음은 원칙적으로 1회 재생성을 시도한다.
- 원전 핵심 사건이 빠진 경우
- catalog summary와 본문 전개가 크게 어긋나는 경우
- 결말이나 핵심 메시지가 원전 또는 catalog 의도와 크게 달라졌고, 그 변경이 서사상 자연스럽거나 필요한 각색으로 보기 어려운 경우
- 안전 완화 과정에서 이야기의 갈등/대가/성장이 사라진 경우
- `long` 또는 `series`로 잡았는데 실제 본문이 핵심 전개를 담지 못할 만큼 얇은 경우

재생성은 기존 id를 보존해야 하므로 `--story-id`와 `--overwrite`를 사용한다. 재생성 프롬프트에는 빠진 핵심 사건을 `--synopsis`로 명시한다. 1회 재생성 후에도 같은 문제가 남으면 무한 재생성하지 않고 이번 커밋에서 제외한다.

커밋에서 제외한 항목은 별도 작업에서 다시 다룬다.
- length를 올린다.
- 해당 원전의 coverage scope를 더 좁게 다시 정의한다.
- synopsis와 핵심 사건 목록을 더 구체화해 다시 생성한다.

### 5.3 허용 가능한 각색

아동용 각색에서는 일부 완화가 가능하다.
- 직접적인 죽음, 잔혹한 처벌, 공포 묘사는 완화할 수 있다.
- 3-5세는 해피엔딩을 우선할 수 있다.
- 6-7세와 8-9세는 원전 결말 유지가 우선이지만, 표현 수위는 낮출 수 있다.
- 폭력 사건은 결과와 의미를 보존하되 묘사를 간접화한다.

다만 완화 때문에 원전의 핵심 인과가 사라지면 품질 이슈로 본다. 예를 들어 "사과를 맞힘"만 남기고 이후 체포/탈출/대립을 모두 삭제하면 `빌헬름 텔`의 핵심 사건량을 충분히 담지 못한 것이다.

## 6. 발견 사항 대응 예시

리뷰 결과는 다음처럼 분류한다.

직접 수정 예시:
- 오타: `슬퐜지만` → `슬펐지만`
- frontmatter 총 읽기 시간과 회차별 읽기 시간 합산 불일치: 회차별 합산에 맞춰 frontmatter를 수정
- 직접화법 문장부호 누락: 대사 앞뒤 따옴표만 보강

재생성 1회 시도 예시:
- 불화의 사과 이야기에서 "불화"와 그 여파가 사라진 경우
- 빌헬름 텔 이야기에서 사과 맞히기 이후 체포, 탈출, 최종 대립이 빠진 경우
- 요약은 "죗값을 치른다"고 되어 있는데 본문 결말에는 결과나 책임이 없는 경우
- 장편 원전의 후반 핵심 사건을 모두 생략해 `long` 또는 `series` 분량의 의미가 약해진 경우

유지 가능한 예시:
- `(조용히)` 같은 짧은 괄호 감정 지시
- 직접적인 죽음이나 잔혹한 처벌을 간접화한 표현
- 연령대에 맞추기 위해 공포 묘사를 낮춘 표현

## 7. 최종 커밋 전 체크리스트

커밋 전에는 다음을 모두 만족해야 한다.

- 새 콘텐츠가 모두 의도한 모델로 생성됐는지 확인했다.
- 직접 수정한 파일은 오타/문장부호/메타데이터 수준에 머물렀다.
- 원전 핵심 누락 항목은 1회 재생성했고, 그래도 불만족스러운 항목은 이번 커밋에서 제외했다.
- `npm run validate:content`가 통과했다.
- `npm test`가 통과했다.
- `npm run build`가 통과했다.
- 관련 없는 untracked 파일을 커밋에 포함하지 않았다.
- `content/stories.yml`과 새 `content/versions/*.md`만 의도적으로 stage 했다.
