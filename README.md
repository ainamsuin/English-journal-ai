# English Journal AI

한국어로 기록하면 영어 사고를 만들어주는 AI 영어 저널. Gemini API 키는 **서버에만** 저장되고 브라우저(클라이언트)에는 절대 노출되지 않는 구조예요.

```
english-journal-ai/
├── index.html        ← 프론트엔드 (정적 파일, 그대로 서빙됨)
├── api/
│   └── generate.js    ← 서버리스 함수. 여기서만 GEMINI_API_KEY를 사용
├── package.json
├── .gitignore
└── .env.example
```

## 왜 이 구조가 더 안전한가요

- 이전 버전(순수 HTML 파일)은 API 키를 브라우저 `localStorage`에 저장했어요. 파일을 열어보거나 브라우저 개발자 도구를 켜면 키가 그대로 보이는 구조였어요.
- 지금 버전은 `index.html`이 Gemini를 직접 호출하지 않고, 우리 서버의 `/api/generate`를 호출해요. 실제 Gemini 키는 서버의 환경 변수(`GEMINI_API_KEY`)에만 있고, 요청/응답 어디에도 클라이언트로 전달되지 않아요.
- 선택적으로 `APP_SECRET`(앱 비밀번호)을 설정하면, 이 비밀번호를 모르는 사람은 `/api/generate`를 호출해도 401 오류를 받아요. 이 값도 서버 환경 변수로만 관리되고, 사용자는 앱의 ⚙ 설정 화면에 비밀번호만 입력해요.
- 서버 함수에는 간단한 요청 빈도 제한(rate limit)도 들어 있어서, 누군가 URL을 알아내 스크립트로 무한 호출하는 것을 어느 정도 막아줘요.

**한계**: `APP_SECRET`을 설정해도 이 값 역시 클라이언트 JS가 요청 헤더에 실어 보내는 값이라, "인증"이라기보다는 "간단한 접근 제한"에 가까워요. 여러 명이 함께 쓰는 앱이라면 진짜 로그인(예: Google 로그인) 붙이는 게 더 견고해요. 혼자 쓰는 용도로는 지금 구조로 충분해요.

## 배포 방법 (Vercel 기준, 무료)

1. 이 폴더를 GitHub 저장소로 올리세요. **`.env` 파일은 올리지 마세요** (`.gitignore`에 이미 포함되어 있어요).
2. [vercel.com](https://vercel.com) 가입 → "Add New Project" → 방금 만든 저장소 선택 → Deploy (별도 빌드 설정 필요 없음, `index.html`과 `api/`를 자동으로 인식해요).
3. 배포 후 프로젝트 → **Settings → Environment Variables**에서 아래 값을 추가:
   - `GEMINI_API_KEY` = 본인의 실제 Gemini API 키 ([Google AI Studio](https://aistudio.google.com/apikey)에서 발급)
   - `APP_SECRET` = (선택) 원하는 비밀번호. 설정하면 앱 사용 시 ⚙ 화면에 같은 값을 입력해야 해요.
4. 환경 변수를 추가한 뒤 **Redeploy**를 한 번 눌러주세요 (환경 변수는 재배포해야 반영돼요).
5. 발급된 주소(예: `https://your-project.vercel.app`)로 접속하면 바로 사용할 수 있어요.

### 로컬에서 테스트하고 싶다면

```bash
npm install -g vercel
cp .env.example .env.local   # 그리고 .env.local에 실제 키를 채워넣기
vercel dev
```

## 참고

- 이전 대화에서 붙여넣으신 문자열(`AQ.Ab8R...`)은 일반적인 Gemini API 키 형식(`AIzaSy...`)이 아니라 OAuth 관련 토큰처럼 보였어요. 혹시 실제로 쓰이는 자격증명이라면 [Google Cloud Console](https://console.cloud.google.com/apis/credentials)에서 폐기(revoke)하고, Gemini용 API 키는 [Google AI Studio](https://aistudio.google.com/apikey)에서 새로 발급받아 `GEMINI_API_KEY`에 넣어주세요.
- 어떤 값도 이 저장소의 파일 안에는 직접 적어 넣지 마세요. 항상 호스팅 서비스의 환경 변수 설정 화면을 통해 넣어주세요.
