# 1. 프로젝트 개요 (Project Overview)

### 1.1. 개발 목표

사용자가 입력한 **'이야기 제목'**과 **'타겟 연령(만 나이)'**을 기반으로, 해당 연령층의 아이가 **동화책처럼 읽을 수 있는 본문 텍스트(Storybook Prose)**를 생성하는 CLI 기반 LLM 애플리케이션 개발.

### 1.2. 핵심 가치 (Core Value)

단순한 텍스트 생성이 아닌, **"읽기(Text-First)"**와 **"연령 최적화(Age-Adaptive)"**에 초점을 맞춤.

1. **동적 구조화 (Dynamic Structuring):** 원작의 길이에 따라 단편으로 끝낼지, 시리즈로 나눌지, 특정 에피소드만 발췌할지 스스로 판단.
2. **인지 부하 조절 (Cognitive Load Management):** 연령에 따라 등장인물 수를 제한하고 복잡한 서브플롯을 제거.
3. **윤문/가독성 최적화 (Narrative Polish):** 동화책 본문으로 읽기 좋은 문장(호흡, 어미 일관, 명확한 주어)을 만들도록 윤문.

### 1.3. 실행 환경

- **Interface:** Python CLI (Command Line Interface)
- **Input:** `Title` (ex: "반지의 제왕"), `Age` (ex: 5), `Options` (length hint etc.)
- **Output:** 기 정의된 포맷에 맞춰 텍스트 데이터 저장 (File I/O)

---

# 2. 시스템 아키텍처 (System Architecture)

전체 시스템은 **4-Stage Sequential Pipeline**으로 구성됩니다. 각 스테이지는 독립적인 LLM Agent(혹은 Chain)로 동작하며, 이전 단계의 산출물을 입력받습니다.

### 2.1. 데이터 흐름도 (Data Flow)

Plaintext

`[User Input] 
   │ (Title, Age)
   ▼
[1. Planner Agent] ──▶ (Context Search & Logic)
   │ 
   │ <Output: Story Blueprint>
   │  ├─ Format/Length Tier (single/series, short/medium/long)
   │  ├─ Character List (Filtered)
   │  └─ Plot Outline (Scene by Scene)
   ▼
[2. Writer Agent]
   │ 
   │ <Output: Raw Story Draft>
   │  └─ Age-appropriate content, safety filtered
   ▼
[3. Critic Agent]
   │
   │ <Output: Pass/Fail + Fix Notes>
   │  └─ Safety + Plan Alignment + Length Fit
   ▼
[4. Editor Agent] ──▶ (Oral Style Converter)
   │ 
   │ <Output: Polished Script>
   │  └─ Final text ready for narration
   ▼
[File Saver] (Existing Module)`

### 2.2. 모듈별 상세 역할 (Component Specs)

### **Step 1: Planner Agent (기획자)**

이야기의 '설계도'를 그리는 단계입니다. 텍스트를 바로 쓰지 않고 구조만 잡습니다.

- **주요 기능:**
    - **Format/Length Decision:** 입력값과 연령에 따라 `format(single|series)`와 `length_tier(short|medium|long|series)`를 결정.
        - 사용자가 length/episode를 강제하면 `format=series`를 유지하고 `episode_count`는 3~8 범위로 맞춤.
    - **Coverage Scope:** 원전에서 다룰 범위를 짧게 명시. 원작이 연령에 적합하면 사건/결말을 유지하고 요약·생략만 허용(새 사건/교훈 추가 금지).
    - **Character Compression:** 연령별 허용치에 맞춰 조연 삭제/병합.
    - **Outline Design:** `episode_outlines`(회차 단위)를 설계.
    - **Unclear Source Handling:** 원전이 불명확하더라도 안전한 핵심 구간을 골라 완결된 계획을 만든다. 요약 요청을 강제하지 않는다.
- **Output Data (JSON):** `story_summary`, `version_summary`, `characters[]`, `episode_outlines[]`, `tone_guide`, `style_guide`, `format`, `length_tier`, `episode_count`, `coverage_scope`, `source_basis`

### **Step 2: Writer Agent (작가)**

설계도를 바탕으로 실제 이야기를 집필합니다. 문체보다는 '내용'과 '묘사'에 집중합니다.

- **주요 기능:**
    - **Safety Filter:** 폭력적/선정적 묘사를 연령에 맞는 메타포로 치환. (죽음 -> 먼 여행, 피 -> 빨간 물감 등)
    - **Sensory Description:** 아이의 상상력을 자극하는 시각/청각적 묘사 추가.
    - **Scenario Expansion:** Planner가 준 Scene Outline을 실제 문장으로 확장.
- **Output Data (Text):** 문어체로 작성된 초안 텍스트.

### **Step 3: Critic Agent (검토)**

내용과 안전성을 검증하는 단계입니다. Writer 결과를 바로 수정하지 않고, **통과/실패 + 수정 지침**을 제공합니다.

- **주요 기능:**
    - **Safety & Age Fit:** 연령 금지 소재, 공포/폭력 표현 수위를 점검.
    - **Plan Alignment:** 플랜과의 일치 여부(등장인물/장면/결말) 확인.
    - **Length Fit:** 목표 길이 범위 충족 여부 확인(크게 벗어나면 fail).
- **Output Data (JSON):** `status(pass|fail)`, `reasons[]`, `notes`

### **Step 4: Editor Agent (윤문 전문가)**

내용 수정 없이, 문장 구조와 어미를 **동화책 본문으로 읽기 좋게** 고칩니다.

- **주요 기능:**
    - **Style Conversion:** 종결어미/서술 톤을 타겟 연령에 맞게 정리하고 작품 내 일관 유지.
        - *3~5세:* "했어요체" + 감탄사 + 의성어/의태어
        - *6~9세:* "했어요체 또는 했습니다체" 중 하나 선택 + 작품 내 일관
    - **Breath Control:** 읽기 흐름이 자연스럽도록 긴 문장 분절.
    - **Subject Restoration:** 대명사(그, 그녀)를 고유명사로 치환하여 문장 명확성 확보.
    - **No Audio Markup:** `[SFX: ...]`, `[Pause: ...]` 같은 오디오 지시문은 사용하지 않음. (감정표현 괄호는 필요할 때만 최소한으로 허용)
    - **Bedtime Tone:** 자기 전에 읽어주는 상황을 기본으로 가정하고, 과한 구연 톤 업(과도한 감정 지시/과격한 호흡/느낌표 남발)을 피한다.
- **Output Data (Text):** 최종 완성된 동화책 본문.

---

### 2.3. 개발 시 고려사항 (CLI Implementation Note)

- **Series Loop:** Planner가 시리즈물(3~8부작)로 기획한 경우, CLI 메인 루프에서 Writer → Critic → Editor를 회차 수만큼 반복 호출해야 함. 이때 Writer는 `prev_story_summary`를 컨텍스트로 받아야 함.
- **Fail-safe:** 원전을 확신할 수 없더라도 입력을 막지 않는다. 안전한 핵심 구간을 선택해 완결된 버전을 만들고, 과도한 추정이나 새 사건 추가는 피한다.

---

# 3. 핵심 로직 명세 (Core Logic Specs)

LLM을 호출하기 전후에 적용되어야 할 규칙과 알고리즘입니다. 이 규칙은 프롬프트 변수(Variable)로 주입되거나, 애플리케이션의 분기(If-else) 처리에 사용됩니다.

### 3.1. 연령별 어댑테이션 매트릭스 (Age Adaptation Matrix)

`user_age` 입력값에 따라 `Planner`와 `Editor`에게 전달할 파라미터(Constraint)를 결정하는 매핑 테이블입니다.

| **구분** | **3~5세** | **6~7세** | **8~9세** |
| --- | --- | --- | --- |
| **인물 수 제한** | 최대 3명 | 최대 4명 | 최대 4명 |
| **문체 스타일** | **친절한 했어요체** (질문형 어미 허용) + 의성어/의태어 강화 | **차분한 했어요체 또는 했습니다체** (작품 내 일관) | **차분한 했어요체 또는 했습니다체** (작품 내 일관) |
| **금지 소재** | 구체적인 폭력, 죽음, 유괴 | 심한 신체 훼손, 비극적 결말 | 심한 신체 훼손, 비극적 결말 |
| **문장 길이** | 중문 위주 (접속사 1개 허용) | 복문 허용, 호흡 분절 | 복문 허용, 호흡 분절 |
| **갈등 해결** | 권선징악/화해 중심, 해피엔딩 | 원작의 결말/톤 유지 (억지 해피엔딩 금지) | 원작의 결말/톤 유지 (억지 해피엔딩 금지) |

> 현재 파이프라인은 6~7세와 8~9세에 동일한 규칙을 적용한다.

### 3.2. 포맷/길이 결정 로직 (Format & Length Decision Logic)

Planner가 산출하는 **format/length_tier**를 결정하는 로직입니다.

1. **입력 우선 규칙:**
    - **IF** `length=series` 또는 `episodes` 지정 → `format=series`, `length_tier=series`, `episode_count=3~8` (범위 밖이면 조정).
    - **IF** `length=short|medium|long` → `format=single`, `length_tier=해당 값`, `episode_count=1`.
2. **자동 선택 (length=auto):**
    - **큰 서사(장편/대서사)** + **연령 7세 이상** → `format=series` 선택 가능.
    - 그 외에는 `format=single` + `length_tier=short/medium/long` 중 적합한 길이 선택.
3. **Series 구성 규칙:**
    - 3~8화로 사건을 명확히 분할하고, 회차 말미는 부드러운 cliffhanger를 둔다.
4. **Coverage Scope:**
    - 원전에서 어떤 구간을 다루는지 한 줄로 명시한다.

---

# 4. 단계별 프롬프트 엔지니어링 가이드 (Prompt Guide)

각 에이전트에게 주입할 `System Prompt`와 `User Input` 템플릿입니다. 개발 시 `{변수명}` 형태는 실제 데이터로 치환해야 합니다.

### Step 1: Planner Agent (기획)

- **목표:** 원작 분석 및 구조 설계 (Stage 1: 자연어 계획 → Stage 2: JSON)
- **System Prompt:**Markdown
    
    `You are a professional story architect for children's literature.
    Your goal is to design a story structure suitable for the target age.
    
    [Constraints]
    1. Assume the title is a known story; choose a clear coverage_scope.
    2. Decide format/length_tier based on input and age.
       - If length=series or episodes is provided, set format=series and keep episode_count within 3~8.
       - If length=short/medium/long, set format=single and episode_count=1.
    3. If the original is age-appropriate, keep events/ending; do NOT add new events or moral framing.
    4. Limit main characters to Max Characters; merge/remove minors.
    5. Stage 1: natural language plan (no JSON). Stage 2: output JSON only.`
    
- **User Input Template:**Plaintext
    
    `Title: {title}
    Target Age: {age} years old
    Length Hint: {length}
    Episodes (optional): {episodes}
    Max Characters Allowed: {max_char_limit} (Refer to Logic 3.1)
    
    Task: Create a blueprint for this story, including format/length_tier and episode outlines.`
    

### Step 2: Writer Agent (집필)

- **목표:** 초안 작성 (Safety Filter 적용)
- **System Prompt:**Markdown
    
    `You are a creative fairy tale writer. Write a story based on the provided blueprint.
    
    [Safety Guidelines for Age {age}]
    - Violence: {violence_rule} (e.g., Replace 'kill' with 'chase away', 'blood' with 'red paint')
    - Tone: Warm, engaging, and age-appropriate.
    - Sensory Details: Focus on what characters see, hear, and feel.
    
    [Instructions]
    1. Follow the plot points in the blueprint strictly.
    2. Write in plain text (Draft).
    3. Do NOT worry about specific sentence endings (this will be polished later), focus on the content flow and descriptions.
    4. The prose must read like a top-tier Korean children's storybook written for this exact age.`
    
- **User Input Template:**Plaintext
    
    `Blueprint: {json_output_from_planner}
    Target Age: {age}
    
    Task: Write the full story draft.`
    
### Step 3: Critic Agent (검토)

- **목표:** 안전/플랜 정합성/길이 체크 (Stage 1: 자연어 검토 → Stage 2: JSON)
- **System Prompt:**Markdown
    
    `Role: Safety & Logic Critic
    You must evaluate whether the draft is safe and aligned to the blueprint.
    
    [Checklist]
    1. Safety for target age
    2. Alignment with plan (characters, events, ending)
    3. Length within target range
    
    Output JSON only in Stage 2 with status(pass|fail), reasons[], notes.`
    
- **User Input Template:**Plaintext
    
    `Blueprint: {json_output_from_planner}
    Draft Story: {output_from_writer}
    Target Age: {age}
    Length Target: {length_target}
    
    Task: Review and return pass/fail with reasons.`
    

### Step 4: Editor Agent (윤문 및 구연 최적화)

- **목표:** 동화책 본문 윤문(문장/호흡/톤 정리)
- **System Prompt:**Markdown
    
    `You are a professional Korean children's storybook editor.
    Your task is to polish the draft into final storybook prose the reader can read like a book.
    
    [Style Guide for Age {age}]
    - Ending Style: {ending_style} (e.g., "했어요체 또는 했습니다체" with consistency)
    - Sentence Length: {sentence_length_rule}
    - Clarity: Replace ambiguous pronouns (he/she) with proper nouns (names) to ensure clarity.
    
    [Refinement Rules]
    1. Keep plot unchanged. Do NOT add new events or moral frames.
    2. Ensure narration uses one consistent tone (했어요체 또는 했습니다체).
    3. Add rhythm and sound words (의성어/의태어) if the target age is under 6.
    3. Break down long sentences for better breath control.
    4. Do NOT include audio direction markup like [SFX], [Pause].`
    
- **User Input Template:**Plaintext
    
    `Draft Story: {output_from_writer}
    Target Age: {age}
    
    Task: Rewrite this into final storybook prose (plain text only).`
    

---

### 개발자 팁 (Implementation Tips)

1. **JSON Parsing:** Planner/Plan Review/Plan Revise/Critic은 **2단계 호출**(자연어 → JSON)로 안정화한다. JSON 단계에서는 스키마만 강제하고, 빈 값은 빈 문자열/배열로 채우도록 지시한다.
   - Plan Review/Critic은 일부 스키마 필드가 선택형이므로, Structured Output 제약(모든 필드 required)으로 실패할 수 있다. 이 경우 JSON 강제 파싱 경로를 사용한다.
2. **Character Consistency:** 시리즈물일 경우, Step 1에서 생성된 캐릭터 리스트를 저장해두었다가 Step 2(Writer) 호출 시 매번 주입해야 등장인물 이름이 바뀌지 않습니다.
3. **Critic Loop:** Critic이 `fail`이면 Rewrite를 수행하고, 최대 2회 내에서 재검토 후 Editor로 넘깁니다.
4. **Prompt Tuning:** `{violence_rule}`이나 `{ending_style}` 같은 변수는 코드 레벨에서 3.1의 매트릭스를 참고하여 구체적인 문자열로 매핑해주는 것이 좋습니다.
    - *예:* `violence_rule` (4세) -> "No death, no scary monsters. Villains should be mischievous, not evil."

# 5. 부록: 품질 고도화 및 세부 가이드 (Appendix: Advanced Quality Control)

본 섹션은 기본 파이프라인(Planner-Writer-Critic-Editor)의 결과물 품질을 '상용 서비스 수준'으로 끌어올리기 위한 필수적인 추가 요구사항을 정의합니다.

### 5.1. 언어 설정 및 번역투 방지 (Language Specification)

모든 에이전트의 내부 사고 과정(Chain of Thought)은 영어로 진행될 수 있으나, **최종 사용자에게 전달되는 결과물은 반드시 '한국어(Korean)'여야 합니다.**

- **System Prompt 최상단 필수 지침:**Markdown
    
    `[GLOBAL LANGUAGE RULE]
    1. MAIN OUTPUT LANGUAGE: KOREAN (한국어).
    2. Even if the user input or context is in English, the final story MUST be written in fluent, native-level Korean.
    3. Avoid direct translation styles (Translationese). Use natural Korean sentence structures and vocabulary appropriate for children.`
    

### 5.2. 퓨샷(Few-Shot) 프롬프팅 전략 : "스타일만 모방하기"

예시를 제공할 때 LLM이 예시의 '줄거리'까지 베끼는 과적합(Overfitting) 현상을 방지하기 위해, **예시의 내용과 실제 생성해야 할 이야기의 내용을 분리**해야 합니다.

- **전략 A: 전혀 다른 주제의 예시 사용 (Cross-Domain Example)**
    - 판타지 소설을 쓸 때, 예시는 '요리법 설명'이나 '일상 대화'를 해당 문체로 변환한 것을 보여줍니다.
    - *이유:* 내용적 유사성이 없으므로 LLM이 줄거리를 베낄 위험이 사라지고, '말투'만 학습합니다.
- **전략 B: 네거티브 프롬프트(Negative Constraint) 추가**Markdown
    - 프롬프트에 다음 지침을 명시합니다.
    
    `[Few-Shot Instruction]
    - The examples below are ONLY for learning the 'Tone & Manner'.
    - DO NOT copy any plot, characters, or objects from the examples.
    - Apply this style strictly to the CURRENT story blueprint provided.`
    

### 5.3. 자가 수정 루프 (Refinement Loop with Critic)

Writer가 작성한 초안을 바로 Editor에게 넘기지 않고, **'Critic(비평가)'** 모듈을 통해 검증하는 단계를 추가합니다. 이는 안전성 위반이나 개연성 부족을 막는 안전장치입니다.

- **Workflow:** `Writer` -> `Critic` -> (If Fail: Rewrite) -> `Editor`
- **Critic Agent Prompt 예시:**Markdown
    
    `Role: Safety & Logic Critic
    Input: Draft Story
    Checklist:
    1. Is the content safe for a {age}-year-old? (Refer to Safety Rubric)
    2. Are there any plot holes compared to the blueprint?
    3. Is the ending strictly happy/resolved? (For age 3~5)
    
    Output:
    - If Pass: "PASS"
    - If Fail: "FAIL" + [Reason for failure]`
    
- **개발 가이드:** `Critic`이 'FAIL'을 반환하면, `Writer`에게 실패 사유(`feedback`)를 포함하여 다시 생성을 요청하는 `While` 루프를 최대 2회까지 구현하십시오.

### 5.4. 표기 규칙 (Formatting)

동화책 본문은 **순수 텍스트**를 기본으로 하며, 오디오 지시문 마크업은 포함하지 않습니다.

- 금지: `[SFX: ...]`, `[Pause: ...]` 같은 오디오 지시문
- 허용: (속삭이며) 같은 괄호 감정표현은 필요할 때만, 대사 바로 앞에서만 최소한으로

---

### 5.5. 상세 안전성 변환 기준표 (Detailed Safety Rubric)

이 기준표는 원작의 자극적인 요소(왼쪽)를 타겟 연령(상단)에 맞춰 어떻게 치환(오른쪽)해야 하는지 정의합니다.

| **카테고리** | **원작/자극적 요소** | **3-4세 (영유아)안정감, 애착 중심** | **5-6세 (유치원)규칙, 권선징악 중심** | **7세+ (초등 저학년)모험, 용기 중심** |
| --- | --- | --- | --- | --- |
| **죽음 / 살해** | 죽었다, 살해당했다, 목숨을 잃었다 | **[완전 배제/먼 여행]**
멀리 이사를 갔다, 긴 여행을 떠났다, 깊은 잠이 들었다. | **[추상적/은유적]**
별이 되었다, 하늘나라로 갔다, 다시는 볼 수 없게 되었다. | **[사실적/비극적 수용]**
세상을 떠났다, 생을 마감했다.
*(단, 시신 묘사는 금지)* |
| **신체 훼손** | 잘렸다, 피가 튀었다, 눈을 파먹었다 | **[단순 통증/실수]**
아이쿠 쿵 했다, 밴드를 붙였다, 혹이 났다. | **[비현실적/만화적]**
납작하게 눌렸다, 엉덩이가 뜨거워 펄쩍 뛰었다, 붕대를 감았다. | **[전투적 타격/부상]**
상처를 입었다, 쓰러졌다, 무릎이 까져 피가 났다. |
| **잡아먹힘** | 늑대가 할머니를 삼켰다, 씹어 먹었다 | **[숨바꼭질/가두기]**
옷장에 숨겼다, 입안에 꿀꺽 넣었다가 뱉었다(놀이처럼). | **[통째로 삼킴 (탈출 가능)]**
꿀꺽 삼켰지만 뱃속에서 살아 있었다.
*(소화 과정 묘사 금지)* | **[위협/잡아먹으려 함]**
잡아먹으려고 덤벼들었다.
*(실제 섭취 장면은 회피하거나 그림자 처리)* |
| **유괴 / 납치** | 자루에 담아갔다, 억지로 끌고 갔다 | **[길 잃음/따라감]**
나비를 쫓다 길을 잃었다, 낯선 사람을 따라가면 안 되는데 따라갔다. | **[속임수/함정]**
맛있는 것으로 꼬여내 데려갔다, 창고에 가두었다. | **[강제적 이동]**
억지로 마차에 태웠다, 밧줄로 묶어 데려갔다. |
| **공포 / 괴물** | 찢어질 듯한 비명, 기괴한 생김새, 어둠 | **[장난꾸러기/우스꽝]**
심술궂은 덩치, 엉덩이가 큰 도깨비, 장난치기 좋아하는 여우. | **[나쁜 짓을 하는 존재]**
욕심쟁이 마녀, 무서운 목소리의 늑대.
*(이유 있는 공포)* | **[위압적 존재/악당]**
사악한 마법사, 불을 뿜는 용, 어둠의 기사. |
| **가족 분리** | 숲에 버렸다, 부모가 죽어 고아가 됐다 | **[잠시 떨어짐]**
숨바꼭질하다 못 찾았다, 잠시 심부름을 갔다. | **[어쩔 수 없는 상황]**
너무 가난해서 잠시 헤어지기로 했다, 길을 잃어버려 혼자가 됐다. | **[원작 설정 유지]**
새어머니가 쫓아냈다, 부모님을 여의고 혼자 남았다. |
| **징벌 (결말)** | 불에 태워 죽임, 돌을 매달아 수장 | **[개과천선/화해]**
잘못을 빌고 착해졌다, 친구가 되었다. | **[도망/추방]**
혼이 나서 멀리 도망갔다, 엉엉 울며 사라졌다. | **[응징/인과응보]**
감옥에 갇혔다, 큰 벌을 받았다, 낭떠러지로 떨어졌다. |

**적용 예시 (Case Simulation)**

이 기준표가 실제로 적용되었을 때, 같은 장면이 어떻게 달라지는지 개발자에게 예시로 보여주면 이해가 빠릅니다.

**Case: <헨젤과 그레텔>의 '마녀가 아이들을 잡아먹으려 하고, 아이들이 마녀를 화덕에 미는 장면'**

- **3-4세 (Toddler):**
    
    > "마녀 할머니는 헨젤에게 맛있는 밥을 많이 주었어요. 사실 마녀는 심술쟁이라서 헨젤을 뚱뚱하게 만들고 싶었거든요. 그레텔은 마녀 몰래 헨젤을 도와줬어요. 마녀가 '아이쿠!' 하고 넘어졌을 때, 헨젤과 그레텔은 '메롱!' 하고 집으로 도망쳤답니다."
    > 
    - *포인트:* 잡아먹는 의도 삭제, 화덕에 미는 살인 미수 삭제 -> 넘어짐과 도망으로 순화.
- **5-6세 (Preschool):**
    
    > "마녀는 헨젤을 잡아먹으려고 했어요. '너 살이 쪘는지 보자!' 마녀가 화덕 문을 열었을 때, 그레텔이 용기를 냈어요. '에잇!' 하고 마녀를 화덕 쪽으로 밀었죠. '아 뜨거워! 내 엉덩이!' 마녀가 펄펄 뛰며 도망갔고, 아이들은 무사히 빠져나왔어요."
    > 
    - *포인트:* 잡아먹는 위협 존재, 화덕에 밀지만 죽지 않고 뜨거워서 도망감(권선징악).
- **7세+ (Elementary):**
    
    > "사악한 마녀는 헨젤을 잡아먹기 위해 화덕의 불을 피웠습니다. 마녀가 헨젤을 잡으려는 순간, 그레텔이 온 힘을 다해 마녀를 화덕 안으로 밀어버렸습니다. '으악!' 마녀의 비명과 함께 화덕 문이 닫혔습니다. 드디어 무서운 마녀가 사라진 것입니다."
    > 
    - *포인트:* 생명의 위협 명시, 마녀의 최후(사라짐)를 암시적으로 표현하여 긴장감 유지.
