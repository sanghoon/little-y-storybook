# CLI 콘텐츠 생성 파이프라인

정적 콘텐츠를 미리 생성하기 위한 CLI 파이프라인입니다. LangChain + LangGraph로 **Planner → Writer → Critic → Editor** 순서로 생성하고, 결과를 `content/versions/`에 저장합니다.

## 파이프라인 개요
- **Planner**: 원전 범위/형식(format, length_tier) 결정 → 원작이 연령에 적합하면 사건/결말 유지(요약/생략만 허용) → 캐릭터 압축 → 씬/에피소드 설계
- **Writer**: 설계도 기반 초안 작성(문어체 중심, 안전 가이드 적용, 감각 묘사 강화)
- **Critic**: 안전/개연성/플랜 이탈 점검 → 실패 시 최대 2회 재작성
- **Editor**: 구연체 변환 + 감정/효과음/쉬어가기 태그 추가

### 포맷/길이 규칙
- **format**: `single` 또는 `series`
- **length_tier**: `short|medium|long` (format=single), `series` (format=series)
- **episode_count**: format=single이면 1, format=series이면 3~8

## 사전 준비
- `.env`에 `OPENAI_API_KEY` (또는 프로젝트에서 쓰는 OpenAI 키) 설정
- LangSmith/Tracing을 쓰는 경우 아래 중 하나를 설정
  - `LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_API_KEY`
  - 또는 `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY`

## 실행 예시
```bash
npm run generate:story -- \
  --title "고래 친구 별이" \
  --synopsis "밤바다에서 길 잃은 새끼 고래가 별빛을 따라 집을 찾는 이야기" \
  --age "6-7" \
  --length "short" \
  --tags "바다,우정,모험"
```

## 주요 옵션
- `--title`, `--synopsis`: 제목/시놉시스 중 하나는 필수
- `--story-title`: 버전 그룹핑용 스토리 표준 제목 (동일 제목 유지)
- `--story-id`: 기존 `content/stories.yml`의 story id 재사용
- `--age`: 대상 연령대 (예: `3-5`, `6-7`, `8-9`)
- `--length`: `short|medium|long|series|auto`
- `--episodes`: 연작 분량 강제 지정
- `--source`: 원전 제목 (미지정 시 `title` 사용)
- `--max-iterations`: Critic 재작성 루프 최대 횟수 (최대 2로 캡)
- `--plan-max-iterations`: 플랜 리뷰/수정 루프 최대 횟수 (기본 2)
- `--output`: 저장 경로 직접 지정
- `--print`: 결과를 stdout에 출력
- `--dry-run`: 파일 저장 생략

## 결과 파일 형식
`content/versions/<english-slug>__<age>__<length>.md` 형식으로 저장됩니다.
스토리 인덱스는 자동으로 `content/stories.yml`에 반영됩니다.
생성 과정 메타데이터는 `content/versions/meta/<english-slug>__<age>__<length>.json`에 저장됩니다.

Editor 결과에는 낭독을 돕기 위한 오디오 지시문이 포함됩니다.
예: `(활기차게)`, `[SFX: 바람 소리]`, `[Pause: Short]`

```md
---
id: "ver_20251228_..."
story_id: "story_011"
title: "..."
summary: "..."
age_range: "6-7"
length_type: "series"
estimated_read_time: 12
actual_char_count: 1800
actual_word_count: 420
actual_sentence_count: 55
generation_meta_path: "content/versions/meta/....json"
tags: ["...", "..."]
---
### 1화
- estimated_read_time: 4
본문...
```

## 검증 스크립트
생성된 콘텐츠와 `content/stories.yml`의 정합성을 검사합니다.

```bash
npm run validate:content
```
