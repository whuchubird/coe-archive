// 서버 API 호출을 한 곳으로 모은 얇은 fetch 래퍼.
// 페이지마다 fetch 옵션을 다시 적지 않게 하고, 실패를 예외로 바꿔
// 호출부가 try/catch 하나로 처리할 수 있게 한다.

const BASE = '/api';

// 서버가 4xx·5xx를 돌려줬을 때 던지는 오류.
// 상태 코드를 들고 있어 호출부가 401(로그인 필요)과 나머지를 구분할 수 있다.
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  // 로그인이 필요한 상황인지 한 번에 확인한다.
  get isUnauthorized() {
    return this.status === 401;
  }
}

// 응답 본문을 JSON으로 읽는다. 본문이 없거나 JSON이 아니면 null로 둔다.
async function readJson(response) {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 실제 요청. 모든 메서드가 이 함수를 거친다.
async function request(method, path, body) {
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      // 세션 쿠키를 항상 실어 보낸다. 이게 없으면 로그인 상태가 유지되지 않는다.
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    // 네트워크가 끊겼거나 서버가 죽은 경우. status가 없으므로 0으로 표시한다.
    throw new ApiError('서버에 연결할 수 없습니다.', 0, null);
  }

  const data = await readJson(response);

  if (!response.ok) {
    // 서버는 항상 { error: "메시지" } 형태로 답한다. 없으면 상태 코드로 대체한다.
    throw new ApiError(data?.error ?? `요청에 실패했습니다. (${response.status})`, response.status, data);
  }

  return data;
}

// 객체를 쿼리스트링으로 바꾼다.
// 값이 비었으면(빈 문자열·null·빈 배열) 조건 자체를 빼고,
// 배열은 서버가 기대하는 쉼표 구분 문자열로 합친다. (예: country=Brazil,Guatemala)
export function buildQuery(params = {}) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }

  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

// 호출부에서 쓰는 형태. api.get('/beans?page=1') 처럼 짧게 적는다.
export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  // 권한 변경처럼 한 필드만 고칠 때 쓴다.
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path)
};

export default api;
