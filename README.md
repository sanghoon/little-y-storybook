# Little Y Storybook

아이에게 읽어주기 좋은 이야기를 **연령/길이/태그 기준으로 탐색**하고 읽을 수 있는 모바일 웹 스토리북입니다.
정적 콘텐츠(Markdown)로 운영하며, 버전별(연령/길이) 이야기를 독립적으로 노출합니다.

## 핵심 기능
- 연령/길이/태그 필터 + 키워드 검색
- 읽기 화면에서 메타 정보/회차 이동/읽기 설정 통합
- 연작(Series) 회차 이동 및 이어보기
- 글자 크기 조절, 진행 표시
- SEO 기본 메타, 접근성 포커스 스타일

## 기술 스택
- **Astro** (정적 빌드)
- **Markdown + frontmatter** (콘텐츠)
- **Vanilla CSS**
- **Vitest** (간단 테스트)

## 콘텐츠 구조
- 버전 1개 = 파일 1개
- 경로: `content/versions/*.md`

예시:
```md
---
id: ver_010_a
title: 별을 찾는 아이
summary: 사라진 별을 찾아 떠나는 아이의 이야기
age_range: 8-9
length_type: series
estimated_read_time: 10
tags: [상상, 감동, 창작]
---
### 1화
- estimated_read_time: 5
본문...

### 2화
- estimated_read_time: 5
본문...
```

## 로컬 실행
```bash
npm install
ASTRO_TELEMETRY_DISABLED=1 npm run dev -- --host 127.0.0.1 --port 4321
```

## 테스트
```bash
npm test
```

## 빌드
```bash
npm run build
```

## 콘텐츠 생성 CLI
정적 콘텐츠를 미리 생성하기 위한 파이프라인입니다.

```bash
npm run generate:story -- --title "..."
```

옵션 예시:
```bash
npm run generate:story -- --title "호빗" --age "6-7" --length "series"
```

생성 후 콘텐츠 검증:
```bash
npm run validate:content
```

자세한 사용법은 `docs/cli-content-pipeline.md`를 참고하세요.

## 배포 (Vercel)
1) GitHub에 푸시된 `main` 브랜치를 Vercel에 연결
2) Framework: **Astro**
3) Build Command: `npm run build`
4) Output Directory: `dist`

`main` 브랜치에 push하면 자동 배포됩니다.

## 문서
- 기획/요구사항/IA: `docs/`
- 화면 스펙: `docs/screens/`
- 콘텐츠 샘플: `docs/content/samples/`
