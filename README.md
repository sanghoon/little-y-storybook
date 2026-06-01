# Little Y Storybook

부모가 아이에게 잠자리에서 읽어주기 좋은 동화를 **연령과 길이, 태그를 기준으로 쉽게 탐색하고 읽을 수 있도록 돕는 모바일 웹 스토리북**입니다.

동일한 동화라도 아이의 인지 발달 수준(연령대)과 독서 시간(길이)에 맞게 윤문/편집된 다수의 버전을 제공하며, 복잡한 기능 없이 오직 **'부모가 아이에게 직접 책을 읽어주는 경험'**에 최적화되어 있습니다.

## ✨ 주요 기능

*   **다양한 버전 제공:** 하나의 이야기를 연령(`3-5세`, `6-7세`, `8-9세`)과 길이(`짧음`, `보통`, `김`, `짧은 연작`, `긴 연작`) 조합으로 제공합니다.
*   **연작(Series) 모드:** 긴 이야기는 여러 회차로 나뉘어 제공되며, `짧은 연작(3~4화)`과 `긴 연작(5화 이상, 실제 생성은 보통 5~8화)`으로 구분됩니다. 스크롤과 로컬 스토리지를 이용해 자동으로 마지막에 읽은 회차를 기억합니다.
*   **읽기 최적화:** 큰 글씨, 여유 있는 줄 간격, 다크 모드, 방해 요소 없는 읽기 화면.
*   **빠른 탐색:** 제목 및 키워드 검색, 태그 기반 필터링(연령, 길이, 테마).

## 🛠 기술 스택

*   **프레임워크:** [Astro](https://astro.build/) (정적 웹 사이트 생성)
*   **콘텐츠:** Markdown + YAML Frontmatter
*   **스타일링:** Vanilla CSS (`src/styles/global.css`)
*   **테스트:** Vitest
*   **파이프라인:** Node.js 기반 CLI 툴 (`@langchain/core` 활용)

## 📁 주요 디렉토리 구조

```text
little-y-storybook/
├── content/
│   ├── versions/        # Markdown 기반의 실제 동화 콘텐츠 파일들
│   └── stories.yml      # 전체 스토리 인덱스 및 메타데이터
├── docs/                # 기획서, 화면 스펙, 파이프라인 가이드 등
├── pipeline/            # LLM 파이프라인 생성 로그 및 메타데이터
├── scripts/             # CLI 기반 콘텐츠 자동 생성 및 검증 스크립트
├── src/
│   ├── layouts/         # 웹페이지 기본/읽기 레이아웃 (Astro)
│   ├── pages/           # 홈, 목록, 읽기 화면 라우팅 (Astro)
│   ├── lib/             # 마크다운 파싱 등 공통 유틸리티 로직
│   └── styles/          # 글로벌 CSS 스타일
└── tests/               # Vitest 단위 테스트 파일
```

## 🚀 시작하기

이 프로젝트는 정적 사이트(Static Site)이므로 데이터베이스나 복잡한 백엔드 없이 바로 실행할 수 있습니다.

### 설치 및 로컬 실행

```bash
# 1. 의존성 설치
npm install

# 2. 로컬 개발 서버 실행 (기본 포트: 4321)
npm run dev

# (선택) Astro 원격 텔레메트리 끄기
ASTRO_TELEMETRY_DISABLED=1 npm run dev -- --host 127.0.0.1 --port 4321
```

### 테스트 및 빌드

```bash
# 단위 테스트 실행
npm test

# 프로덕션 빌드 (결과물은 /dist 에 생성)
npm run build

# 빌드 결과물 로컬에서 미리보기
npm run preview
```

## 📚 문서 안내

- 전체 문서 목록: [`docs/README.md`](docs/README.md)
- 제품/요구사항 개요: [`docs/product-brief.md`](docs/product-brief.md), [`docs/requirements.md`](docs/requirements.md)
- 콘텐츠 데이터 구조: [`docs/content-model.md`](docs/content-model.md), [`docs/content-template.md`](docs/content-template.md)
- 콘텐츠 샘플: [`docs/content-samples.md`](docs/content-samples.md)
- 자동 생성 파이프라인: [`docs/cli-content-pipeline.md`](docs/cli-content-pipeline.md)
- 수동 생성/에이전트용 명세: [`docs/manual-story-generation.md`](docs/manual-story-generation.md)
- 화면 스펙: [`docs/screens/home.md`](docs/screens/home.md), [`docs/screens/list.md`](docs/screens/list.md), [`docs/screens/detail.md`](docs/screens/detail.md), [`docs/screens/reader.md`](docs/screens/reader.md)

## 🤖 LLM 기반 콘텐츠 생성 (CLI)

이 프로젝트는 LangChain과 LLM(Gemini 등)을 활용해 입력한 제목/시놉시스로 **연령에 맞는 맞춤형 동화를 자동 생성**하는 파이프라인을 내장하고 있습니다. 

*생성된 콘텐츠는 `content/versions/`에 저장되며 웹사이트에 바로 노출됩니다.*

### 환경 변수 설정
로컬 스토리 생성을 위해 `.env.example`을 참고해 `.env` 파일을 생성하고 LLM API 키를 입력하세요.

```bash
cp .env.example .env
```

### 콘텐츠 생성하기

```bash
# 기본 사용법 (자동으로 연령/길이를 판단해 1개 버전 생성)
npm run generate:story -- --title "빨간 모자"

# 세부 옵션 지정 (예: 6-7세 대상의 긴 연작 스토리 생성)
npm run generate:story -- --title "호빗" --age "6-7" --length "long_series"
```

### 길이 선택 가이드

길이는 연령대가 아니라 **원전의 필수 사건량**과 **압축 손실**을 기준으로 고릅니다. 6-7세 대상이어도 원전 핵심 장면이 많으면 `long` 또는 `short_series` 이상을 선택하고, 문장 난이도만 낮춥니다.

- `short`: 단일 사건이나 감정선을 중심으로 하는 짧은 우화. 대략 3~5분, 공백 제외 700~1100자를 목표로 합니다.
- `medium`: 필수 장면이 2개 안팎인 단순한 단편. 유명 원전 전체를 담는 기본값으로 쓰지 않습니다. 대략 6~10분, 공백 제외 1100~1700자를 목표로 합니다.
- `long`: 필수 장면이 3~5개이지만 한 번에 읽는 단편으로 유지할 수 있는 이야기. 대략 11~20분, 공백 제외 1700~2500자를 목표로 합니다.
- `short_series`: 여정, 반복 시련, 조력자/적대자 변화, 관계 변화가 있어 3~4개의 자연스러운 회차 분절이 필요한 이야기. 회차당 공백 제외 700~1700자를 목표로 합니다.
- `long_series`: 장편 원전, 여러 장소/시련/인물군을 거치는 모험담이나 성장 서사. 실제 생성은 보통 5~8화로 맞춰지며, 회차당 공백 제외 700~1700자를 목표로 합니다.

`series`는 하위 호환을 위한 예전 alias이며, 새로 생성할 때는 `short_series` 또는 `long_series`를 사용하는 것을 권장합니다.

생성 후 콘텐츠가 인덱스(`stories.yml`)와 정합성이 맞는지 검증할 수 있습니다.
```bash
npm run validate:content
```

> **자세한 파이프라인 가이드:** [`docs/cli-content-pipeline.md`](docs/cli-content-pipeline.md) 참고
