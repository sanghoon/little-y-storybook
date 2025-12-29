# 콘텐츠 모델 (Content Model)

## 핵심 개념
- Story: 하나의 이야기 콘셉트(예: "달 토끼의 모험")
- Version: Story의 편집본(연령/길이/난이도별)
- Tag: 분류/탐색을 위한 키워드

## 엔티티 관계
- Story 1 : N Version
- Story N : N Tag
- Version N : N Tag (버전 특화 태그)

## Story 필드(예시)
- id, title, summary
- default_cover_image
- status (draft/published)

## Version 필드(예시)
- id, story_id
- title_override (optional)
- age_range (예: 3-5)
- length_type (short/medium/long/series)
- pipeline_version (생성 파이프라인 버전, optional)
- estimated_read_time (추정치, 분 단위)
- audio_url (optional, TTS 오디오 파일 URL)
- body (본문, 연작형이 아닐 때)
- chapters (연작형일 때)
  - 회차별 본문을 배열로 분리
  - 필드: title, body, estimated_read_time, audio_url (optional)
- tags (version-specific)
- status (draft/published)
  - 연작형(length_type = series)은 chapters 사용

## Tag 필드(예시)
- id, name, type (age/length/theme/mood)

## 예시 데이터 구조 (JSON)
```json
{
  "story": {
    "id": "story_001",
    "title": "달 토끼의 모험",
    "summary": "용감한 토끼가 달을 향해 떠나는 이야기"
  },
  "versions": [
    {
      "id": "ver_001",
      "age_range": "3-5",
      "length_type": "short",
      "estimated_read_time": 4,
      "audio_url": "https://.../ver_001.mp3"
    },
    {
      "id": "ver_002",
      "age_range": "8-9",
      "length_type": "series",
      "estimated_read_time": 12,
      "audio_url": "https://.../ver_002.mp3",
      "chapters": [
        {
          "title": "1화",
          "body": "...",
          "estimated_read_time": 4,
          "audio_url": "https://.../ver_002_ch1.mp3"
        },
        {
          "title": "2화",
          "body": "...",
          "estimated_read_time": 5,
          "audio_url": "https://.../ver_002_ch2.mp3"
        }
      ]
    }
  ]
}
```
