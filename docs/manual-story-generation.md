# Manual Story Generation Guide (CLI AI Agents)

이 문서는 Codex, Gemini-cli 같은 **CLI AI Agent**가 파이프라인을 수동으로 따라 만들 수 있도록 만든 명세다.  
자동 파이프라인과 **동일한 판단 기준/형식**을 수동으로 재현하는 것이 목표다.

---

## 1) 입력 정의 (Input)

필수 입력
- title: 원전 제목
- age_range: `3-5 | 6-7 | 8-9`
- length: `short | medium | long | series`

옵션 입력
- synopsis: 원전이 명확하지 않을 때만 참고 (없어도 진행)
- source_title: 원전 제목 (title과 동일하면 생략 가능)

### 길이 타겟 (공백 제외 글자 수)
- short: 700–1100
- medium: 1100–1700
- long: 1700–2500
- series: 회차당 700–1700

### 연령 규칙 요약
- 3–5세: 해피엔딩 필수, 의성어/의태어 강화
- 6–7세: 원작 결말 유지 우선, 억지 해피엔딩 금지
- 8–9세: 원작 결말/톤 유지, 설명형 도덕화 최소화

---

## 2) 전체 흐름 (Pipeline Steps)

1. **Planner Stage 1 (자연어 계획)**
2. **Planner Stage 2 (JSON 계획)**
3. **Plan Review (자연어 리뷰 → JSON)**
4. **Plan Revise (자연어 수정 계획 → JSON)**
5. **Draft (문어체 초안)**
6. **Critic (자연어 검사 → JSON)**
7. **Rewrite (수정 초안)**
8. **Editor (동화책 최종본)**
9. **Final Packaging (Markdown + Frontmatter)**

> 핵심: **자연어 1차 → 구조화된 2차 정리** 흐름을 지킨다.  
> JSON 출력은 선택 사항이며, **필수 필드가 모두 채워졌는지 점검**하는 것이 목적이다.

---

## 3) Planner 명세

### 3.1 Planner Stage 1 (자연어 계획)
목표: **스토리 구조를 자연어로 정리**

필수 체크리스트
- 원전을 알고 있다는 전제에서 **coverage_scope**를 한 줄로 지정.
- length에 따라 **format/length_tier** 결정
  - length=series → format=series, episode_count는 3–8 범위에서 자동 선택
  - length=short/medium/long → format=single, episode_count=1
- 원작이 연령에 적합하면 **사건/결말 유지**, 요약/생략만 허용
- **새 사건/도덕적 결론 추가 금지**
- 등장인물 수 제한(3-5: 최대 3, 6-7: 최대 4, 8-9: 최대 4)
- **episode_outlines** (회차 단위, 회차마다 다른 사건/전개)

### 3.2 Planner Stage 2 (JSON 계획)
목표: **필수 항목을 빠짐없이 채웠는지 확인**

> 수동 생성 가이드는 대화형을 전제로 한다.  
> **불확실한 부분이 있으면 사용자에게 질문**해도 된다.

> JSON 출력은 강제하지 않는다.  
> 대신 아래 스키마의 **모든 필드가 계획에 포함되어 있는지** 점검한다.

점검 항목 (JSON을 쓰지 않아도 확인)
- 모든 필드가 빠짐없이 채워져 있는가?
- 시리즈라면 episode_outlines가 회차 수만큼 있는가?
- length/format/episode_count가 일관적인가?

필수 필드 체크리스트 (JSON 스키마 기준)
```json
{
  "source_title": "...",
  "source_basis": "known_story | user_synopsis | original",
  "story_title": "...",
  "version_title": "...",
  "story_slug_en": "kebab-case-ascii",
  "target_age_range": "3-5 | 6-7 | 8-9",
  "format": "single | series",
  "length_tier": "short | medium | long | series",
  "episode_count": 1,
  "coverage_scope": "...",
  "story_summary": "...",
  "version_summary": "...",
  "tags": ["..."],
  "characters": ["..."],
  "setting": "...",
  "themes": ["..."],
  "episode_outlines": [
    { "episode": 1, "title": "...", "summary": "...", "beats": ["..."] }
  ],
  "tone_guide": "...",
  "style_guide": "..."
}
```

---

## 4) Plan Review 명세

### 4.1 Review Stage 1 (자연어 리뷰)
목표: 계획 실행 가능성 점검
- format/length_tier/episode_count 일관성
- 등장인물 수/이름 일관성
- 원작 충실도 (새 사건/새 도덕 결론 여부)
- 요약에 제작 메모 금지
- 길이 목표 준수 가능성

### 4.2 Review Stage 2 (JSON 리뷰)
출력 스키마
```json
{
  "status": "pass | revise",
  "issues": [{ "type": "structure|format|length|characters|fidelity|summary|clarity|moral|style|safety|consistency", "detail": "..." }],
  "must_fix": ["..."],
  "suggestions": ["..."],
  "plan_alignment": {
    "read_aloud_ok": true,
    "age_fit_ok": true,
    "episode_cuts_ok": true,
    "notes": ""
  },
  "revision_brief": ""
}
```

---

## 5) Draft / Rewrite 명세

공통 원칙
- **한국어**, **해당 연령대의 동화책으로 자연스러운 문장**
- **문어체 중심**
- **새 사건/도덕 강설 금지**
- 플랜의 **characters/plot/setting** 유지
- 길이 타겟 범위 준수

Rewrite는 Critic 지적사항만 반영하고, 플롯 변경 금지.

---

## 6) Critic 명세

Stage 1: 자연어 검사  
Stage 2: JSON 출력

```json
{
  "status": "pass | fail",
  "reasons": ["..."],
  "notes": ""
}
```

---

## 7) Editor 명세

필수 사항
- 서술문은 **했어요체 또는 했습니다체 중 하나로 일관**
- **대사는 인물 성격에 맞게 자유롭게**
- `[SFX: ...]`, `[Pause: ...]` 같은 오디오 지시문은 사용하지 않음
- 자기 전에 읽어주는 상황을 기본으로 가정하고 **차분/따뜻한 톤**을 우선
- (속삭이며) 같은 괄호 감정표현은 필요할 때만, 대사 바로 앞에서만 최소한으로 허용(과한 구연 톤 업 금지)
- 플롯 변경 금지

---

## 8) Final Packaging (Markdown)

권장 메타데이터
- 자동 파이프라인과 동일하게 `estimated_read_time`, `actual_char_count`(공백 제외), `actual_word_count`, `actual_sentence_count`를 채운다.
- 수동 생성이라 `generation_meta_path`는 없어도 된다(있다면 실제 경로만).

단편 예시
```md
---
id: "ver_XXX"
story_id: "story_XXX"
title: "..."
summary: "..."
age_range: "6-7"
length_type: "short|medium|long"
pipeline_version: "v3-gemini"
estimated_read_time: 6
actual_char_count: 1200
actual_word_count: 350
actual_sentence_count: 90
tags: ["...", "..."]
---
본문...
```

시리즈 예시
```md
---
id: "ver_XXX"
story_id: "story_XXX"
title: "..."
summary: "..."
age_range: "6-7"
length_type: "series"
pipeline_version: "v3-gemini"
estimated_read_time: 12
actual_char_count: 4000
actual_word_count: 1200
actual_sentence_count: 300
tags: ["...", "..."]
---
### 1화
본문...

### 2화
본문...
```

---

## 9) CLI Agent용 간단 체크리스트

- JSON은 **문자열 줄바꿈 없이** 출력했는가?
- 요약에 제작 메모가 없는가?
- 원작 결말/사건을 불필요하게 바꾸지 않았는가?
- 연령대 금지 요소가 들어가지 않았는가?
- 시리즈라면 회차가 3–8 범위인가?
