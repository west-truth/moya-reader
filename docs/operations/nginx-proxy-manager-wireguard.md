# WireGuard 전용 Nginx Proxy Manager 배포 예제

Status: configuration example; target host verification pending
Last reviewed: 2026-08-24

이 문서는 Nginx Proxy Manager(NPM)를 이미 Docker로 운영하고, WireGuard에 연결된 개인 기기에서만
모야와 Suwayomi에 접근하는 구성을 설명한다. 예시 도메인은 다음과 같다.

```text
https://moya.example.com
https://suwayomi.example.com
```

저장소의 Web/API/worker Compose 경로와 Suwayomi API 계약은 로컬에서 검증되었다. 그러나 이 문서의 실제
DuckDNS, WireGuard 방화벽, NPM 인증서와 두 Proxy Host 설정은 대상 서버에서 아직 검증하지 않았다. 따라서
아래 절차를 적용한 뒤 마지막 확인 항목을 실제 기기에서 수행해야 한다.

## 1. 권장 네트워크 구조

```text
WireGuard client browser
  ├─ HTTPS → NPM → moya-web:80
  │                    └─ /api → Moya API/worker/storage
  └─ HTTPS → NPM → moya-suwayomi:4567
                       └─ installed Mihon-compatible sources
```

NPM이 Docker 컨테이너라면 Proxy Host의 forwarding 주소에 `127.0.0.1`을 사용하면 안 된다. 그 주소는
Docker 호스트가 아니라 NPM 컨테이너 자신을 가리킨다. NPM과 모야 컨테이너를 같은 외부 Docker network에
연결하고 고유한 network alias를 사용한다.

이 예제의 기본 network 이름은 `npm_proxy`이다. 아직 없다면 한 번만 만든다.

```bash
docker network create npm_proxy
```

이미 같은 이름의 network가 있으면 새로 만들지 않는다. NPM 자체 Compose에도 이 network를 외부 network로
연결해야 한다. NPM Compose에서 실제 서비스 이름이 `app`이 아니라면 아래 `app`을 해당 이름으로 바꾼다.

```yaml
services:
  app:
    networks:
      default:
      npm-proxy:

networks:
  npm-proxy:
    name: npm_proxy
    external: true
```

실행 중인 컨테이너에 `docker network connect`만 적용하면 다음 NPM 재생성 때 연결이 사라질 수 있으므로,
운영 설정은 NPM Compose 파일에 남긴다.

모야의 `.env`에는 같은 network 이름과 고유 alias를 둔다.

```dotenv
NPM_DOCKER_NETWORK=npm_proxy
MOYA_PROXY_HOSTNAME=moya-web
SUWAYOMI_PROXY_HOSTNAME=moya-suwayomi
TRUSTED_PROXY_HOPS=2
```

`compose.suwayomi.yaml`을 포함한 Compose 구성을 사용하면 Web과 Suwayomi가 이 외부 network에 연결된다.
호스트의 `8080`을 계속 loopback에만 두더라도 NPM은 Docker network 안에서 `moya-web:80`으로 접근할 수 있다.
`TRUSTED_PROXY_HOPS=2`는 API 앞의 Moya Web과 NPM 두 홉만 신뢰한다. NPM 없이 Moya Web에 직접 접속하는
기본 Compose는 `.env.example`의 `1`을 유지한다.

## 2. WireGuard 전용 HTTPS 경계

DuckDNS 이름을 쓴다는 사실만으로 서비스가 인터넷에 공개되는 것은 아니다. 다음 두 조건을 별도로 지킨다.

1. WireGuard client가 두 이름을 NPM 서버의 WireGuard 주소로 해석하거나 그 주소로 라우팅한다.
2. 호스트 방화벽은 NPM의 443 ingress를 `wg0` 또는 WireGuard 주소 대역으로 제한한다.

NPM Access List는 편의 기능이지 WireGuard 방화벽의 대체물이 아니다. Docker NAT 때문에 NPM이 원래 client
주소 대신 gateway 주소를 볼 수도 있으므로 실제 격리는 호스트 방화벽과 WireGuard routing에서 적용한다.
인증서 발급에 DNS-01 challenge를 사용하면 일반 인터넷에서 80/443을 열 필요가 없다. HTTP-01을 사용해야
한다면 발급 중의 공개 경계와 발급 후 방화벽 복구를 운영자가 별도로 관리해야 한다.

두 origin 모두 정상적으로 신뢰되는 HTTPS 인증서를 사용한다. HTTPS Moya에서 HTTP Suwayomi 주소를 직접
호출하면 mixed-content 또는 private-network access 정책에 막힐 수 있다.

## 3. NPM Proxy Host: Moya

NPM의 `Hosts → Proxy Hosts → Add Proxy Host`에서 다음 값을 사용한다.

| 필드                  | 값                 |
| --------------------- | ------------------ |
| Domain Names          | `moya.example.com` |
| Scheme                | `http`             |
| Forward Hostname / IP | `moya-web`         |
| Forward Port          | `80`               |
| Websockets Support    | 켬                 |

SSL 탭에서는 해당 도메인의 인증서를 선택하고 `Force SSL`과 `HTTP/2 Support`를 켠다. HSTS는 HTTPS와
WireGuard routing이 실제 기기에서 확인된 뒤 켜는 편이 안전하다.

NPM의 Advanced 설정에는 대형 원본·백업과 긴 import 응답을 위해 다음 경계를 적용할 수 있다.

```nginx
client_max_body_size 512m;
proxy_request_buffering off;
proxy_buffering off;
proxy_read_timeout 900s;
proxy_send_timeout 900s;
```

내부 Moya nginx가 `/api`를 API 컨테이너로 전달하므로 NPM에 별도 `/api` Custom Location은 만들지 않는다.
`compose.public.yaml`의 `READER_AUTH_TOKEN`, PostgreSQL과 MinIO 자격증명은 그대로 필요하다. 토큰은 첫 브라우저의
소유자 계정 생성 때 한 번만 초기 설정 코드로 쓰며 이후 기기는 아이디·비밀번호로 로그인한다. NPM은
`Set-Cookie`, `Host`, `X-Forwarded-Proto`를 그대로 전달해야 30일 HttpOnly 세션이 다음 접속에도 복구된다.

`compose.suwayomi.yaml`은 Web을 외부 NPM network에 연결하므로 같은 필수 자격증명과 external exposure 검사를
overlay 안에서도 반복한다. 실수로 `compose.public.yaml`을 빠뜨려도 Compose 설정 단계에서 중단되며, 표준 실행
명령은 계속 세 파일을 모두 사용한다.

`compose.metadata-collector.yaml`을 함께 사용하는 경우도 NPM 설정은 바뀌지 않는다. 표지·작품 정보 요청은
같은 Moya `/api` gateway를 거쳐 내부 수집기로 전달되므로 별도 Proxy Host, Custom Location 또는 8000 포트
공개가 필요 없다. 이 구조는 NPM 전용이 아니며 Caddy, Traefik과 일반 nginx에서도 동일하다.

선택형 `compose.metadata-collector-auth.yaml`을 더해 19세 인증 브라우저를 쓰는 경우도 동일하다. 화면과 입력은
기존 `/api`의 bounded HTTP frame/action으로 전달되므로 WebSocket 지원이나 timeout용 Custom Location을 추가하지
않는다. 로그인 입력이 이 HTTPS 경로를 통과하므로 Proxy Host의 SSL은 반드시 유지하고, 신뢰할 수 없는 평문 HTTP
경로에는 auth override를 노출하지 않는다.

## 4. NPM Proxy Host: Suwayomi

두 번째 Proxy Host를 다음 값으로 만든다.

| 필드                  | 값                     |
| --------------------- | ---------------------- |
| Domain Names          | `suwayomi.example.com` |
| Scheme                | `http`                 |
| Forward Hostname / IP | `moya-suwayomi`        |
| Forward Port          | `4567`                 |
| Websockets Support    | 켬                     |

SSL 탭에서는 Suwayomi 도메인의 인증서를 선택하고 `Force SSL`과 `HTTP/2 Support`를 켠다. 큰 CBZ 응답을
중간에 끊지 않도록 Advanced 설정에 다음 값을 둘 수 있다.

```nginx
proxy_buffering off;
proxy_read_timeout 900s;
proxy_send_timeout 900s;
```

Suwayomi에는 자체 `ui_login` 또는 `basic_auth` 인증을 반드시 사용한다. `ui_login`은 access/refresh token을
사용하므로 모야의 기본 권장값이다. NPM의 HTTP Basic Access List와 Suwayomi 인증을 동시에 걸면 하나의
`Authorization` 헤더가 충돌할 수 있으므로, 이 구성에서는 WireGuard 경계와 Suwayomi 자체 인증을 사용한다.

```dotenv
SUWAYOMI_AUTH_MODE=ui_login
SUWAYOMI_AUTH_USERNAME=개인사용자이름
SUWAYOMI_AUTH_PASSWORD=충분히긴별도비밀번호
```

연결 후 Suwayomi WebUI에서 신뢰하는 extension store를 등록하고 필요한 source를 설치한다. 기본 Compose는
`EXTENSION_STORES` 환경 변수를 강제로 주입하지 않으므로 WebUI에서 저장한 목록을 다음 재시작 때 빈 값으로
덮어쓰지 않는다. 이용 권한이 있는 source와 콘텐츠만 등록한다.

Suwayomi 데이터는 `suwayomi-data` named volume에 남는다. 평상시 업데이트에 `docker compose down -v`를
사용하면 안 된다. 해당 명령은 설치한 source, 설정과 library 데이터를 삭제하는 초기화 작업이다.

## 5. 모야 런타임 공개 설정과 OAuth origin

Docker Web은 이미지 재빌드 없이 컨테이너 시작 시 공개 런타임 설정을 받는다. 실제 변수 이름은
`.env.example`을 기준으로 하고, Suwayomi 기본 주소에는 외부 HTTPS origin을 사용한다.

Suwayomi 주소는 scheme, host와 선택적 port만 있는 별도 origin이어야 한다. 현재 bridge는 root의
`/api/graphql`과 chapter download 경로를 사용하므로 `/suwayomi` 같은 subpath, query, fragment 또는 URL
userinfo는 지원하지 않는다.

```dotenv
MOYA_SUWAYOMI_DEFAULT_URL=https://suwayomi.example.com

MOYA_DROPBOX_APP_KEY=공개앱키
MOYA_DROPBOX_SOURCE_APP_KEY=선택사항인별도공개앱키
MOYA_GOOGLE_DRIVE_CLIENT_ID=공개웹클라이언트ID
MOYA_GOOGLE_DRIVE_APP_ID=숫자프로젝트번호
MOYA_GOOGLE_DRIVE_DEVELOPER_KEY=origin제한한브라우저키
```

`MOYA_PUBLIC_ORIGIN` 같은 별도 origin 변수는 필요하지 않다. OAuth origin과 redirect URI는 브라우저의 실제
`window.location`에서 파생되므로 NPM이 원래 `Host`와 `X-Forwarded-Proto`를 보존하는지만 확인한다.

이 값들은 브라우저 앱의 공개 식별자다. Dropbox App Secret, Google Client Secret, provider API key와
Suwayomi 비밀번호는 런타임 공개 설정에 넣지 않는다.

OAuth console에는 브라우저가 실제 사용하는 Moya origin만 등록한다. Suwayomi subdomain은 Dropbox/Google
OAuth callback origin이 아니다.

Dropbox Redirect URI는 마지막 `/`까지 정확히 등록한다.

```text
https://moya.example.com/
```

Google OAuth Web Client의 승인된 JavaScript origin에는 경로와 마지막 `/` 없이 등록한다.

```text
https://moya.example.com
```

Google browser API key의 website 제한에는 다음 referrer pattern을 둔다.

```text
https://moya.example.com
https://moya.example.com/*
```

OAuth 제공자가 Moya나 Suwayomi 컨테이너에 server-to-server callback을 보내는 구조가 아니다. 로그인한
브라우저가 callback origin으로 돌아오므로 그 기기가 WireGuard에 연결되어 있고 도메인을 올바르게 해석할 수
있으면 된다.

## 6. 시작과 업데이트

처음 시작하기 전에 외부 network와 `.env`를 확인한다.

```bash
docker network inspect npm_proxy
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml config --quiet
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml up -d --build
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml ps
```

GitHub에서 제품 업데이트를 받은 뒤에는 같은 Compose 파일 조합을 유지한다. Suwayomi `stable` image도
갱신하려면 먼저 image를 pull한다.

```bash
git pull --ff-only
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml pull suwayomi
docker compose -f compose.yaml -f compose.public.yaml -f compose.suwayomi.yaml up -d --build --remove-orphans
```

`.env`와 named volume은 Git 대상이 아니므로 정상적인 pull/recreate로 삭제되지 않는다. `COMPOSE_PROJECT_NAME`과
Compose 파일 조합을 설치 후 임의로 바꾸면 다른 이름의 빈 volume을 붙일 수 있으므로 그대로 유지한다.

## 7. 실제 완료 확인

WireGuard에 연결된 PC와 모바일 기기에서 각각 확인한다.

- `https://moya.example.com/health`가 응답하고 인증서 경고가 없는가?
- 모야에서 `.env`와 같은 Reader bearer token을 저장한 뒤 Library와 import가 동작하는가?
- Dropbox 로그인 후 정확한 Moya 주소로 돌아오고 연결이 유지되는가?
- Google Picker에서 선택한 파일이 Source Hub에 남는가?
- `https://suwayomi.example.com`에 인증 없이 데이터가 노출되지 않는가?
- 모야의 `설정 → 소스`에 기본 Suwayomi 주소가 HTTPS subdomain으로 보이는가?
- Suwayomi에 설치한 합법적인 Mihon-compatible source 하나가 모야 Source Hub에서 작품·회차까지 열리는가?
- WireGuard를 끈 기기에서는 두 origin에 접근할 수 없는가?
- 컨테이너 재생성 뒤 Moya 데이터, OAuth 연결 정보와 Suwayomi 설정·source가 유지되는가?

현재 자동·로컬 검증은 Compose contract와 Suwayomi API fixture까지다. 위 대상-host/WireGuard/NPM/live extension
항목을 통과하기 전에는 실제 개인 서버 배포까지 검증됐다고 기록하지 않는다.

Suwayomi image 환경 변수와 데이터 경로는
[공식 Docker 저장소](https://github.com/Suwayomi/Suwayomi-Server-docker)를, 인증 모드의 의미는
[공식 서버 설정 문서](https://github.com/Suwayomi/Suwayomi-Server/wiki/Configuring-Suwayomi%E2%80%90Server#authentication)를
기준으로 한다.
