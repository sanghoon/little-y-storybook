# 콘텐츠 템플릿 (Story/Version)

정적 운영 기준으로 **Version 1개 = 파일 1개**의 Markdown + YAML frontmatter 포맷을 사용합니다.

## 파일 frontmatter (공통)
```yaml
---
id: ver_000
title: 제목
summary: 한 줄 소개
age_range: 3-5 / 6-7 / 8-9
length_type: short / medium / long / series
pipeline_version: v1
estimated_read_time: 4
audio_url: https://.../audio.mp3
tags: [선택 태그들]
---
```

## 본문 (단편/장편)
```md
여기에 본문 텍스트...
```

## 본문 (연작)
```md
### 1화
- estimated_read_time: 4
- audio_url: https://.../ch1.mp3
여기에 1화 본문...

### 2화
- estimated_read_time: 4
- audio_url: https://.../ch2.mp3
여기에 2화 본문...
```
