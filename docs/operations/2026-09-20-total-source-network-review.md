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

수정 방향: Mangayomi 호환 상태를 확장별로 제한된 용량 안에서 보관하되 실제 캐시 용량을 수용. 사용자 입력 설정과 실행 중 저장 데이터의 검증 목적을 구분하고, 저장 성공 후 재열기도 확인. 한도 초과를 일반 연결 실패로 표시하지 않도록 오류 매핑 보완. 검증을 건너뛰거나 캐시를 임의 삭제하는 방식은 피함. **아직 구현하지 않음.**

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

기존 Moya `pinnedProxyAgent()`는 HTTP(S)/SOCKS5를 지원하고 승인된 **IP**로 프록시에 연결하며 TLS 호스트 이름을 유지함. 따라서 프록시를 연결하더라도 목적지 DNS는 Moya 서버가 담당한다. DoH가 필요하면 resolver 변경도 별도로 검토해야 함. Mangayomi는 소스별 프록시 옵션을 사용하며, `.moyaext`의 전역 환경변수 fallback과 동일하다고 가정하지 말 것.

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
