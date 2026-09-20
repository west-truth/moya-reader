# TOTAL 토끼 및 표지 네트워크 검토

검토일: 2026-09-20. 운영 설치/설정/DNS/프록시/방화벽은 변경하지 않음.
사용자는 Intra를 켰을 때 **Mangayomi 앱**의 표지가 정상 표시됐다고 확인함. Moya 웹에서의 비교 결과는 아님.

## TOTAL 토끼 목록 실패: Moya 저장 한도

- 운영 TOTAL 토끼 만화는 0.1.8. 설치된 원본 JS를 읽기 전용으로 복사해 격리된 호출에 사용.
- 운영 웹 로그의 해당 소스 목록 요청은 HTTP 422. 이전에 발견한 API 프로세스 종료/502와는 별개 경로.
- 원본 JS의 `getPopular(1)` 호출 자체는 정상. 상태 JSON·도메인 목록·매핑 JSON·Newtoki 목록 요청이 HTTP 200이며, 안내 카드를 포함한 26개 항목 반환.
- 호출 결과의 SharedPreferences 변경 데이터는 150,299 bytes. 상태 캐시 약 91KB, 작품 매핑 캐시 약 54KB 등이 포함됨. 콘텐츠나 인증 값이 아닌 크기만 기록.
- 같은 결과에 운영 코드의 `validatePreferenceChanges()`를 적용하면 `compatibility_preferences_invalid` 재현. 이 검증은 전체 JSON을 48KiB로 제한하며, 호스트가 결과를 화면으로 전달하기 **전에** 실행됨.
- Mangayomi는 SharedPreferences를 사용자 설정뿐 아니라 소스 캐시 저장에도 사용한다. Moya가 이를 작은 설정 묶음으로 제한한 것이 이번 재현의 원인. 단순 네트워크/DNS 오류나 APK 문제로 분류하면 안 됨.
- 저장 한도만 늘려도 끝나지 않음. 현재 `mangayomi-options`를 저장하는 vault는 읽기 시 64KiB 제한이고, 런타임 JSON 입력/출력에도 한도가 있음. 저장·재열기·누적 데이터 한도를 함께 맞춰야 함.
- 이번 검토는 목록 단계까지. TOTAL의 회차 이미지 경로에는 숨은 브라우저/선택적 외부 인증 서버도 있어 목록 복구만으로 모든 회차의 호환을 주장하지 않음.

구현: 사용자 입력은 기존 48KiB/256키 제한을 유지하고, 소스 실행 상태는 256KiB/2,048키로 별도 검증한다. `mangayomi-options` vault에만 1MiB의 암호화 파일 상한을 적용해 중첩 JSON 이스케이프와 메타데이터를 수용한다. 나머지 인증 저장소의 상한은 늘리지 않는다. vault 쓰기에도 읽기와 같은 상한을 적용하며 초과하면 기존 파일을 교체하지 않는다. 상태 초과 오류는 `source_storage_limit`로 전달해 연결 오류로 감추지 않는다. 캐시 임의 삭제는 하지 않는다.

운영 원본과 같은 SHA-256(`f1d33f361e18801ec152f66f81a6af53751a6d7c0e7ffc1859a28ca2036163b3`)을 격리된 호스트에 설치하고, 실제 인기 목록 26개 → 호스트 종료 → 암호화 저장소 재열기 → 목록 26개를 확인했다. 이번 후속 호출의 상태는 137,958 bytes였다. 외부 상태 JSON은 시점에 따라 크기가 달라진다. 무제한 누적 캐시나 모든 회차 다운로드의 호환을 보장하는 결과는 아니다.

근거:

- [TOTAL 원본 JS](https://dc-toki-mangayomi-manga.pages.dev/javascript/manga/src/ko/total_toki_manga.js)
- [Mangayomi SharedPreferences 브리지](https://github.com/kodjodevf/mangayomi/blob/aaa0aaebe70cbdc42f67fee9f29992ecd5fc4777/lib/eval/javascript/preferences.dart)
- `apps/server/src/extensions/mangayomi/preferences.ts`, `host.ts`, `source-credential-vault.ts`

## Intra와 Moya의 경로 차이

Mangayomi 앱: 휴대폰 → 소스/CDN. Intra는 그 휴대폰의 DNS 질의를 HTTPS로 전달하므로 주소 조회 경로가 달라짐.

Moya의 확장 표지: 휴대폰 → Moya API → 소스/CDN. 원격 소스 요청에는 서버의 DNS·네트워크·인증서 검증이 적용됨. 휴대폰에서 Intra를 켜도 이 서버 쪽 DNS가 변경되지는 않음.

운영 API 컨테이너는 Docker DNS(127.0.0.11), 외부 resolver 8.8.8.8을 사용 중. 이는 암호화 DNS 설정과 다름. `SOURCE_OUTBOUND_PROXY` 환경변수는 비어 있음. 소스별 프록시 설정은 별도이며 이번 검토에서는 인증 저장소를 열어 값을 확인하지 않음.

읽기 전용 비교:

- `sbxh9.com`, 확장 저장소 도메인은 일반 resolver와 Google DoH의 IPv4 답변이 일치.
- `aws-cdn1.site`는 서로 다른 공인 CDN IPv4 반환. CDN 위치 분산으로도 발생할 수 있으므로 이것만으로 DNS 변조를 단정할 수 없음.
- 두 CDN IPv4에 원래 호스트 이름을 유지해 TLS 연결: **둘 다 CERT_HAS_EXPIRED**.
- 확인한 인증서 만료일: 2026-09-17 20:44:51 UTC. DoH로 다른 IP를 받은 이번 비교에서도 만료 오류는 해결되지 않음. 인증서 검증을 꺼서 해결하는 방안은 제안하지 않음.
- 이 결과는 해당 CDN 사례이며 모든 표지 실패가 동일 원인이라는 뜻은 아님. 사용자가 Mangayomi에서 본 표지와 정확히 같은 이미지 URL/연결 설정 비교는 아직 하지 않음.

## 적용 선택지

| 방법                      | Moya에 적용하는 위치                                 | 판단                                                                                                                               |
| ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DoH/DoT resolver          | API 컨테이너가 사용하는 DNS의 상위 resolver          | Intra와 가장 가까운 첫 비교 실험. 별도 DNS 서비스를 통해 Docker 내부 이름 조회는 유지. IP 검증/고정도 유지                         |
| ByeDPI SOCKS5             | 별도 Linux 컨테이너 → 필요한 소스의 기존 프록시 설정 | TLS/DPI 문제가 남으면 제한적으로 비교할 후보. 소스별 적용 가능하며 효과는 대상·통신사별로 확인 필요                                |
| 기존 일반 SOCKS5/VPN 출구 | 소스별 프록시                                        | 실제 다른 출구로 나가면 경로 문제 비교 가능. 단순히 같은 서버의 일반 SOCKS를 거치는 것만으로 DNS 암호화나 DPI 회피가 생기지는 않음 |
| GoodbyeDPI                | Windows 네트워크 드라이버                            | 현재 Linux Docker에 직접 적용하는 도구가 아님                                                                                      |
| zapret 계열               | Linux 네트워크/패킷 처리 계층                        | 가능하지만 방화벽·라우팅 영향이 더 넓음. 소스별 프록시 비교보다 먼저 전체 호스트에 적용할 이유는 현재 증거상 없음                  |

Moya `pinnedProxyAgent()`는 HTTP(S)/SOCKS5를 지원하고 승인된 **IP**로 프록시에 연결하며 TLS 호스트 이름을 유지함. 따라서 프록시를 연결하더라도 목적지 DNS는 Moya 서버가 담당한다. DoH가 필요하면 resolver 변경도 별도로 검토해야 함. 이번 후속 수정에서 Mangayomi와 `.moyaext`의 기본 프록시 선택 경로를 통일했다.

기존 `moya-home-egress-proxy`는 microsocks 기반 일반 SOCKS 서버. ByeDPI나 암호화 DNS 서비스가 아님.

권장 순서:

1. PR #54의 연결 오류로 인한 API 종료 수정 반영.
2. TOTAL의 캐시 저장 제한 수정·저장 후 재열기 확인.
3. 실패 표지의 같은 URL로 직접/DoH 결과를 비교. DNS 효과가 확인되는 소스부터 적용.
4. 유효한 인증서인데도 연결 차단이 남으면 별도 ByeDPI 프록시를 소스별 비교. 인증서 만료·HTTP 권한 오류는 별도 처리.

공식 자료:

- [Intra: DNS-over-HTTPS](https://github.com/Jigsaw-Code/Intra)
- [GoodbyeDPI: Windows/WinDivert](https://github.com/ValdikSS/GoodbyeDPI)
- [ByeDPI: SOCKS proxy, Linux/Docker](https://github.com/hufrea/byedpi)
- [zapret](https://github.com/bol-van/zapret)

## TOTAL 실제 표지 후속 비교

사용자의 추가 확인은 **TOTAL 토끼 / Mangayomi 앱 / Intra 사용**이다. 서버에서 같은 앱 환경이 재현됐다고 주장하지 않는다.

- 실제 목록이 반환한 `aws-cdn9.site/board_uploads/.../144606_0a2f0477f6ec.webp`로 비교했다.
- 운영 API 컨테이너에서 일반 DNS와 Google DoH 모두 `172.67.207.173`, `104.21.77.124`를 반환했다. 원래 TLS 호스트 이름과 인증서 검증을 유지해 두 IP에 각각 연결하자 `ECONNRESET`이었다. 이번 서버 경로에서는 DoH 주소 변경만으로 해결되지 않았다.
- Linux 호스트에서 임시 localhost SOCKS 프록시로 [ByeDPI ba532298](https://github.com/hufrea/byedpi/tree/ba532298de7b28cfe854aea83d061369d13ca290)를 빌드해 비교했다. 옵션은 `--ip 127.0.0.1 --port 18981 --no-udp --disorder 1 --auto=torst --tlsrec 1+s`. 첫 요청은 TLS 실패했고, 자동 대체 설정이 적용된 다음 요청은 HTTP 200, image/webp, **704,176 bytes**였다. DPI 또는 TLS 전송 형태에 따른 차이와 부합하지만, 네트워크 장비 원인을 직접 증명한 것은 아니다. 최초 실패 가능성을 숨기지 않는다.
- 이후 별도 목록 호출에서는 같은 경로의 호스트가 `booktoki8.org`로 바뀌었다. 이 URL은 직접 연결도 성공했다. 프록시 없이는 모든 TOTAL 표지가 실패한다는 결론은 틀리다.
- 격리된 Moya 호스트의 기본 프록시를 임시 SOCKS 주소로 저장하고 실제 `source.getCover`를 호출했다. WebP 704,176 bytes / JPEG 185,067 bytes를 정상 자산으로 반환했다. 임시 소스 설치/암호화 저장소는 종료 후 삭제했다. 임시 ByeDPI 프로세스도 종료했다.
- `aws-cdn1.site`의 앞선 인증서 만료 사례와 `aws-cdn9.site`의 이번 연결 재설정 사례는 서로 다르다. 인증서 검증 해제는 하지 않았다.

## 기본 프록시 사용 방법 / 적용 범위

1. **설정 → 콘텐츠 소스 → 소스 연결 · 기본 프록시**에서 서버가 접근 가능한 HTTP/HTTPS/SOCKS5 주소를 저장한다.
2. 기존 개별 프록시가 없는 소스는 기본값을 자동 사용한다. 기존 개별 주소는 그대로 우선 적용한다.
3. 각 패키지의 **확장 옵션 → 소스 연결 방식**에서 `기본값 사용 / 직접 연결 / 개별 프록시`를 고른다. `직접 연결`은 기본 프록시가 있어도 우회한다. `개별 프록시`는 주소 입력이 필수다. 예전 주소는 모드를 바꿔도 보관하므로 다시 선택할 수 있다.
4. 기본 주소를 비워 저장하면 전역 직접 연결이다. **서버 기본값 복원**은 운영자의 `SOURCE_OUTBOUND_PROXY`로 돌아가며, 환경변수가 없으면 직접 연결한다.

적용 대상은 이 Moya 서버에서 실행하는 Mangayomi JS와 `.moyaext`다. 목록/표지/회차 이미지/브라우저 요청과 SDK 로그인 확인에 적용하며, 해당 형식의 저장소 조회·업데이트 파일 다운로드는 소스별 예외와 별개로 전역 기본값을 사용한다. 별도 Suwayomi 서버, APK Java 실행기, 브라우저 자체 요청, 외부 콘텐츠 생성 서비스의 내부 통신에는 이 기본값을 강제로 적용하지 않는다. 설치 패키지의 옵션 선언이 없어도 `.moyaext` 소스별 호스트 연결 옵션은 표시된다.

설정은 사용자별 기존 서버 vault에 저장되어 서버 재시작과 다른 클라이언트에서도 유지된다. 로컬 UI만 바꾸거나 서버 환경 파일을 덮어쓰지 않는다. 인증된 `GET/PUT /api/source-network-settings`로 관리하고 revision 충돌은 HTTP 409로 거부한다. 저장 후 시작되는 요청부터 적용하며 진행 중 요청과 이미 받은 표지 캐시는 유지한다. 서버 vault 정책에 따라 일반 설정 동기화/내보내기에는 프록시 설정을 복사하지 않는다.

프록시는 별도 서비스다. UI에 주소를 입력하는 것만으로 ByeDPI가 설치되지는 않는다. Docker 배포 시 API와 같은 네트워크의 프록시 서비스 이름(예: `socks5://source-proxy:1080`)을 사용한다. API 컨테이너에서 `127.0.0.1`은 호스트의 임시 프록시를 가리키지 않는다. 이번 작업은 운영용 프록시 서비스 설치, 운영 기본값 지정, DoH resolver 전환을 수행하지 않았다.

검증: 캐시/호스트/기본값·예외 선택/API 충돌/SDK 브로커/설치 UI·클라이언트 관련 9개 파일 33개 테스트 통과. 전체 App 브라우저 검사에서 모바일 기본 프록시 저장, 유효하지 않은 주소 거부, 직접 연결 전환, 기존 설치·업데이트·탐색 흐름을 통과했고 page error는 0이었다. 운영 컨테이너를 다시 빌드하거나 배포하지 않았다.

웹/서버/스크립트 TypeScript, 변경 범위 ESLint, CSS 검사와 `git diff --check`도 통과했다. 새 의존성 설치나 전 플랫폼 테스트 재실행은 하지 않았다.
