import {
  ExternalLink,
  FileArchive,
  FileText,
  Globe2,
  HardDriveDownload,
  Headphones,
  Languages,
  Laptop,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import packageMetadata from '../../../package.json';
import type { PlatformRuntimeInfo, PlatformRuntimeKind, ProviderExecutionRuntimeKind } from '../../platform/runtime';

const archiveBackends = [
  {
    name: '7z-wasm 1.2.0',
    purpose: '암호화된 7z·CB7 열기',
    license: 'GNU LGPL 2.1 이상 및 unRAR 제한',
    source: 'https://github.com/use-strict/7z-wasm',
    licenseFile: '/third_party/licenses/common/LGPL-2.1.txt',
  },
  {
    name: 'node-unrar-js 2.0.2',
    purpose: 'RAR4·RAR5·CBR 열기',
    license: 'MIT wrapper 및 unRAR 제한',
    source: 'https://github.com/YuJianrong/node-unrar.js',
    licenseFile: undefined,
  },
  {
    name: 'libarchive-wasm 1.2.0',
    purpose: '7z·CB7 목록 및 이미지 추출',
    license: 'MIT wrapper, libarchive BSD-2-Clause 및 codec별 라이선스',
    source: 'https://github.com/ofk/libarchive-wasm',
    licenseFile: undefined,
  },
] as const;

interface ApplicationInfoSettingsProps {
  readonly platformRuntime: PlatformRuntimeInfo;
  readonly providerExecutionRuntime: ProviderExecutionRuntimeKind;
}

interface RuntimeHelpItem {
  readonly kind: PlatformRuntimeKind;
  readonly label: string;
  readonly icon: typeof Globe2;
  readonly summary: string;
  readonly limit: string;
}

const runtimeHelpItems: readonly RuntimeHelpItem[] = [
  {
    kind: 'browser',
    label: '웹 브라우저',
    icon: Globe2,
    summary: '브라우저 저장소 · 파일 선택 · 전역 미니 플레이어',
    limit: '백그라운드 재생과 미디어 키는 브라우저와 운영체제가 허용하는 범위에서 동작합니다.',
  },
  {
    kind: 'tauri-desktop',
    label: '데스크톱 앱',
    icon: Laptop,
    summary: '네이티브 파일 입출력 · 보안 저장소 · TTS 오디오 캐시',
    limit: '미디어 키와 잠금 화면 제어는 운영체제 WebView의 Media Session 지원 범위를 따릅니다.',
  },
  {
    kind: 'tauri-mobile',
    label: 'Android 앱',
    icon: Smartphone,
    summary: 'SAF 파일 열기 · Media3 백그라운드 재생 · 네이티브 캐시',
    limit: '오프라인 다운로드는 네트워크·충전 정책에 따라 WorkManager가 이어서 처리합니다.',
  },
] as const;

function runtimeLabel(runtime: PlatformRuntimeInfo): string {
  if (runtime.kind !== 'tauri-mobile') {
    return runtimeHelpItems.find((item) => item.kind === runtime.kind)?.label ?? '알 수 없는 환경';
  }
  return /Android/i.test(runtime.userAgent) ? 'Android 앱' : '모바일 앱';
}

function providerRuntimeLabel(runtime: ProviderExecutionRuntimeKind): string {
  switch (runtime) {
    case 'server':
      return '연결된 서버 작업자 사용';
    case 'desktop':
      return '기기 보안 연결 사용';
    default:
      return '시스템 음성 전용 · 서버 연결 가능';
  }
}

export function ApplicationInfoSettings(props: ApplicationInfoSettingsProps) {
  const isAndroid = props.platformRuntime.kind === 'tauri-mobile' && /Android/i.test(props.platformRuntime.userAgent);
  const mediaSessionAvailable =
    typeof navigator !== 'undefined' && 'mediaSession' in navigator && Boolean(navigator.mediaSession);
  const currentPlayback = isAndroid
    ? '백그라운드 재생 · 알림/잠금 화면 · 오디오 포커스'
    : props.platformRuntime.kind === 'tauri-desktop'
      ? '전역 미니 플레이어 · 미디어 키(WebView 지원 범위)'
      : mediaSessionAvailable
        ? '전역 미니 플레이어 · 브라우저 미디어 키'
        : '전역 미니 플레이어 · 미디어 키 미지원';
  const currentOffline = isAndroid
    ? '네이티브 캐시 · WorkManager 실패 복구'
    : props.platformRuntime.kind === 'tauri-desktop'
      ? '네이티브 TTS 캐시 · 중단 항목 복구'
      : '서버 TTS 연결 시 브라우저 오디오 캐시';
  const currentFiles = isAndroid
    ? 'Android 문서 선택기(SAF)'
    : props.platformRuntime.kind === 'tauri-desktop'
      ? '네이티브 파일 열기 · 저장'
      : '브라우저 파일 선택 · 내보내기';

  return (
    <div className="application-info-settings">
      <section className="application-info-identity" aria-labelledby="application-info-title">
        <div className="application-info-mark" aria-hidden="true">
          모
        </div>
        <div>
          <h3 id="application-info-title">모야</h3>
          <p>텍스트 및 만화 뷰어</p>
        </div>
        <span>v{packageMetadata.version}</span>
      </section>

      <section aria-labelledby="runtime-capability-title">
        <h3 id="runtime-capability-title">현재 실행 환경</h3>
        <div className="application-info-runtime-summary">
          <div>
            {props.platformRuntime.kind === 'browser' ? (
              <Globe2 size={18} aria-hidden="true" />
            ) : props.platformRuntime.kind === 'tauri-desktop' ? (
              <Laptop size={18} aria-hidden="true" />
            ) : (
              <Smartphone size={18} aria-hidden="true" />
            )}
            <div>
              <strong>{runtimeLabel(props.platformRuntime)}</strong>
              <span>{providerRuntimeLabel(props.providerExecutionRuntime)}</span>
            </div>
          </div>
          <dl>
            <div>
              <dt>
                <Headphones size={15} aria-hidden="true" /> 재생
              </dt>
              <dd>{currentPlayback}</dd>
            </div>
            <div>
              <dt>
                <HardDriveDownload size={15} aria-hidden="true" /> 오프라인
              </dt>
              <dd>{currentOffline}</dd>
            </div>
            <div>
              <dt>
                <FileText size={15} aria-hidden="true" /> 파일
              </dt>
              <dd>{currentFiles}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section aria-labelledby="platform-help-title">
        <h3 id="platform-help-title">플랫폼별 동작</h3>
        <div className="application-info-platforms">
          {runtimeHelpItems.map((item) => {
            const Icon = item.icon;
            const current = item.kind === props.platformRuntime.kind;
            return (
              <article key={item.kind} data-current={current || undefined}>
                <div className="application-info-platform-heading">
                  <Icon size={17} aria-hidden="true" />
                  <strong>{item.label}</strong>
                  {current && <span>현재</span>}
                </div>
                <p>{item.summary}</p>
                <small>{item.limit}</small>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="supported-formats-title">
        <h3 id="supported-formats-title">지원 형식</h3>
        <div className="application-info-capabilities">
          <article>
            <FileText size={17} aria-hidden="true" />
            <div>
              <strong>TXT · EPUB</strong>
              <p>본문 검색, 선택·주석, 정확한 청취 위치와 TTS를 지원합니다.</p>
            </div>
          </article>
          <article>
            <Languages size={17} aria-hidden="true" />
            <div>
              <strong>PDF</strong>
              <p>내장 텍스트, 필요한 페이지의 OCR, 검색·주석·TTS를 지원합니다.</p>
            </div>
          </article>
          <article>
            <FileArchive size={17} aria-hidden="true" />
            <div>
              <strong>ZIP · CBZ · RAR · CBR · 7z · CB7</strong>
              <p>연속·양면 보기, 좌→우·우→좌 진행, crop·색 보정과 ComicInfo.xml을 지원합니다.</p>
            </div>
          </article>
        </div>
        <p className="application-info-note">
          분할 압축 파일은 지원하지 않습니다. 암호는 현재 열기 세션의 메모리에만 보관되며 로그·설정·백업에 저장되지
          않습니다.
        </p>
      </section>

      <section aria-labelledby="privacy-info-title">
        <h3 id="privacy-info-title">데이터와 AI·TTS 연결</h3>
        <div className="application-info-inline">
          <ShieldCheck size={17} aria-hidden="true" />
          <p>
            책과 독서 기록은 기본적으로 기기에 저장됩니다. AI와 TTS 요청은 UI에서 외부 API를 직접 호출하지 않고 설정한
            서버 작업자 또는 기기의 보안 연결을 통해 처리됩니다.
          </p>
        </div>
      </section>

      <section aria-labelledby="open-source-title">
        <div className="application-info-section-heading">
          <h3 id="open-source-title">오픈소스 및 제3자 고지</h3>
          <a href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">
            고지 전문 <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
        <p className="application-info-note">
          아래 항목은 현재 배포물에 포함되는 압축 파일 구성요소입니다. 전체 라이선스 원문은 배포물의
          <code> third_party/licenses </code> 디렉터리에 함께 제공됩니다.
        </p>
        <div className="application-info-licenses">
          {archiveBackends.map((backend) => (
            <article key={backend.name}>
              <div>
                <strong>{backend.name}</strong>
                <span>{backend.purpose}</span>
                <small>
                  {backend.license}
                  {backend.licenseFile ? (
                    <>
                      {' · '}
                      <a href={backend.licenseFile} target="_blank" rel="noreferrer">
                        LGPL 2.1
                      </a>
                    </>
                  ) : null}
                </small>
              </div>
              <a href={backend.source} target="_blank" rel="noreferrer" aria-label={`${backend.name} 소스 열기`}>
                소스 <ExternalLink size={13} aria-hidden="true" />
              </a>
            </article>
          ))}
        </div>
        <p className="application-info-note">
          모야의 소스 코드는{' '}
          <a href="/LICENSE" target="_blank" rel="noreferrer">
            Apache License 2.0
          </a>
          으로 배포됩니다.
        </p>
      </section>
    </div>
  );
}
