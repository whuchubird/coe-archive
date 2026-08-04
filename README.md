# COE ARCHIVE

Cup of Excellence 2025 수상 커피 아카이브입니다.

## 공통 페이지 템플릿

각 HTML 페이지는 아래 구조를 기준으로 작성한다. `data-auth="unknown"`은 로그인 상태를
확인하는 동안 회원·비회원 메뉴가 동시에 보이는 것을 막는다. `<head>`의 짧은 테마
스크립트는 CSS를 읽기 전에 저장된 모드를 적용해 화면이 번쩍이는 현상을 줄인다.

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>페이지 제목 — COE ARCHIVE</title>

  <script>
    try {
      const savedTheme = localStorage.getItem('coe-theme');
      const systemTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = savedTheme || systemTheme;
    } catch {
      document.documentElement.dataset.theme = 'light';
    }
  </script>

  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;600&display=swap">
  <link rel="stylesheet" href="/css/common.css">
</head>
<body data-auth="unknown">
  <a class="skip-link" href="#main">본문으로 건너뛰기</a>

  <header class="site-header">
    <div class="site-header__inner container">
      <a class="brand" href="/index.html"><span class="brand__mark">COE</span> ARCHIVE</a>

      <nav aria-label="주요 메뉴">
        <ul class="nav" role="list">
          <li><a class="nav__link" href="/beans.html">아카이브</a></li>
          <li><a class="nav__link" href="/stats.html">통계</a></li>
          <li><a class="nav__link" href="/guide.html">가공방식</a></li>
          <li><a class="nav__link" href="/brew.html">추출 계산기</a></li>
          <li class="auth-only"><a class="nav__link" href="/notes.html">내 노트</a></li>
          <li class="guest-only"><a class="nav__link" href="/login.html">로그인</a></li>
          <li class="auth-only"><span class="nav__user" data-user-name></span></li>
          <li class="auth-only"><button class="btn btn--sm btn--ghost" type="button" data-logout>로그아웃</button></li>
        </ul>
      </nav>

      <button class="icon-btn" type="button" data-theme-toggle aria-label="다크 모드로 전환">☾</button>
    </div>
  </header>

  <main id="main" class="page container">
    <h1>페이지 제목</h1>
  </main>

  <footer class="site-footer">
    <div class="container">
      <p>© 2025 COE ARCHIVE</p>
      <p class="disclaimer">감각 6축과 향미 키워드는 공식 공개 자료가 아닌 가공방식·품종·총점 기반 추정치입니다.</p>
    </div>
  </footer>

  <script type="module" src="/js/common.js"></script>
</body>
</html>
```

## 인증·노트 CRUD curl 테스트

서버를 실행한 뒤 아래 명령을 Git Bash, macOS 또는 Linux 셸에서 순서대로 실행한다.
`cookies.txt`에 세션 쿠키를 저장하며, 모든 인증 요청에 `-c`와 `-b`를 함께 사용한다.
로그인에 성공하면 세션 ID가 새로 발급되므로 `-c`를 빼면 이후 요청이 401이 된다.
`review_user_01`은 아직 가입되지 않은 아이디로 바꿔도 된다.

> **한글이 들어가는 본문은 `-d` 대신 파일로 보낸다.**
> Windows(Git Bash·PowerShell)에서는 `-d '{"comment":"첫 테이스팅"}'` 처럼 명령줄에
> 직접 적은 한글이 UTF-8이 아닌 코드페이지로 전달되어 `ù ���̽���` 처럼 깨져 저장된다.
> 아래처럼 heredoc으로 파일에 쓴 뒤 `--data-binary @파일`로 보내면 정상 처리된다.

```bash
BASE=http://localhost:3000/api
rm -f cookies.txt

# 1. 회원가입 (가입 직후 바로 로그인 상태가 된다)
curl -s -c cookies.txt -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"review_user_01","password":"testpass123"}' \
  "$BASE/auth/register" -w "\n[HTTP %{http_code}]\n"

# 2. 로그인
curl -s -c cookies.txt -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"review_user_01","password":"testpass123"}' \
  "$BASE/auth/login" -w "\n[HTTP %{http_code}]\n"

# 3. 로그인 상태 확인
curl -s -b cookies.txt "$BASE/auth/me" -w "\n[HTTP %{http_code}]\n"

# 4. 노트 생성 — 한글 본문이라 파일로 보낸다
cat > note.json <<'EOF'
{"bean_id":"GT25W01","brew_method":"V60","rating":4,"comment":"첫 테이스팅",
 "aroma":4.0,"acidity":4.5,"body":3.5,"sweetness":4.0,"aftertaste":4.0,"balance":4.0}
EOF
curl -s -c cookies.txt -b cookies.txt \
  -H "Content-Type: application/json" \
  --data-binary @note.json \
  "$BASE/notes" -w "\n[HTTP %{http_code}]\n" | tee create.json

# 생성된 노트 id를 응답에서 뽑는다 (jq 없이)
NOTE_ID=$(grep -o '"id":[0-9]*' create.json | head -1 | cut -d: -f2)
echo "NOTE_ID=$NOTE_ID"

# 5. 내 노트 조회
curl -s -b cookies.txt "$BASE/notes" -w "\n[HTTP %{http_code}]\n"

# 6. 노트 수정
cat > note-edit.json <<'EOF'
{"bean_id":"GT25W01","brew_method":"에어로프레스","rating":5,"comment":"수정한 테이스팅 노트",
 "aroma":4.5,"acidity":4.5,"body":4.0,"sweetness":4.5,"aftertaste":4.0,"balance":4.5}
EOF
curl -s -c cookies.txt -b cookies.txt \
  -X PUT \
  -H "Content-Type: application/json" \
  --data-binary @note-edit.json \
  "$BASE/notes/${NOTE_ID}" -w "\n[HTTP %{http_code}]\n"

# 7. 노트 삭제
curl -s -c cookies.txt -b cookies.txt \
  -X DELETE \
  "$BASE/notes/${NOTE_ID}" -w "\n[HTTP %{http_code}]\n"

# 8. 삭제 확인 → []
curl -s -b cookies.txt "$BASE/notes" -w "\n[HTTP %{http_code}]\n"
```

### 권한 격리 확인

다른 계정으로 쿠키를 하나 더 만들어 남의 노트를 건드려 보면 **404**가 떠야 정상이다.
노트 관련 쿼리는 `WHERE`에 항상 `user_id`가 함께 들어가므로 대상 자체가 잡히지 않는다.

```bash
curl -s -c other.txt -b other.txt \
  -H "Content-Type: application/json" \
  -d '{"username":"review_user_02","password":"testpass123"}' \
  "$BASE/auth/register"

curl -s -b other.txt -X DELETE "$BASE/notes/${NOTE_ID}" -w "\n[HTTP %{http_code}]\n"
```

### Windows PowerShell에서 실행할 때

PowerShell에서 `curl`은 `Invoke-WebRequest`의 별칭이므로 **반드시 `curl.exe`**를 쓴다.
JSON 파일은 `Set-Content -Encoding utf8`로 저장해야 한글이 깨지지 않는다.

```powershell
$BASE = "http://localhost:3000/api"
curl.exe -s -c cookies.txt -b cookies.txt `
  -H "Content-Type: application/json" `
  -d '{\"username\":\"review_user_01\",\"password\":\"testpass123\"}' `
  "$BASE/auth/register"

@'
{"bean_id":"GT25W01","brew_method":"V60","rating":4,"comment":"첫 테이스팅"}
'@ | Set-Content note.json -Encoding utf8

curl.exe -s -c cookies.txt -b cookies.txt `
  -H "Content-Type: application/json" --data-binary "@note.json" "$BASE/notes"
```
