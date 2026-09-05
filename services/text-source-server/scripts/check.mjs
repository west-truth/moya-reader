import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/catalog.mjs';
import { configuredSourcesFromEnvironment } from '../src/source-configuration.mjs';
import { createAdapterRegistry } from '../src/adapter-registry.mjs';
import { createStaticCatalogAdapter } from '../src/static-catalog-adapter.mjs';
import { fetchSourceJson } from '../src/source-http.mjs';

const ACTIONS = {
  invalid_source_http_transport:
    'SOURCE_HTTP_TRANSPORT는 http 또는 browser입니다. SOURCE_BROWSER_CHANNEL은 browser에서만 chromium·chrome·msedge를 선택하세요.',
  invalid_source_configuration: 'SOURCE_ADAPTERS가 지원하는 ID·필드로 이루어진 JSON 배열인지 확인하세요.',
  unsupported_content_provider_protocol: 'CONTENT_PROVIDER_PROTOCOL을 지원하는 job-v1로 설정하세요.',
  content_provider_not_configured:
    '선택한 소스에 필요한 CONTENT_PROVIDER_ENDPOINT와 CONTENT_PROVIDER_KEY를 설정하세요.',
  invalid_content_provider_configuration:
    '본문 공급자의 API origin과 접속 키를 확인하세요. URL 경로·query·내장 credential은 허용하지 않습니다.',
  duplicate_source_adapter: '수동 catalog와 SOURCE_ADAPTERS 사이의 중복 source ID를 수정하세요.',
  invalid_source_adapter: '어댑터의 버전·ID·제목·필수 메서드를 ADAPTERS.md 계약과 맞추세요.',
  invalid_source_registry: '등록 소스 수와 어댑터 목록 형식을 확인하세요.',
};

/** Checks configuration and one optional provider health request. Never calls adapter lists or content/jobs. */
export async function diagnoseSourceServer({
  environment = process.env,
  directory = process.cwd(),
  fetchImpl,
  timeoutMs = 5_000,
} = {}) {
  const checks = [];
  const add = (status, code, message) => checks.push({ status, code, message });
  const key = environment.SERVER_KEY;
  if (
    typeof key !== 'string' ||
    key.length < 16 ||
    key.length > 4_096 ||
    /\s/u.test(key) ||
    key.startsWith('replace-with-')
  )
    add(
      'fail',
      'server_key',
      'SERVER_KEY에 공백 없는 16자 이상의 임의 비밀값을 설정하세요. 최초 설정은 npm run init을 사용하세요.',
    );
  else add('pass', 'server_key', '서버 접속 키 형식을 확인했습니다.');
  const port = Number(environment.PORT ?? 9970);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    add('fail', 'port', 'PORT를 1~65535 사이의 정수로 설정하세요.');
  else add('pass', 'port', '서버 포트 설정을 확인했습니다.');
  if (environment.MOYA_ORIGIN) {
    try {
      const origin = new URL(environment.MOYA_ORIGIN);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== environment.MOYA_ORIGIN)
        throw new Error();
      add('pass', 'browser_origin', '직접 연결용 Moya origin 형식을 확인했습니다.');
    } catch {
      add('fail', 'browser_origin', 'MOYA_ORIGIN에는 경로·끝의 / 없이 Moya의 정확한 http(s) origin을 설정하세요.');
    }
  } else
    add(
      'warning',
      'browser_origin',
      '브라우저에서 직접 연결하려면 MOYA_ORIGIN을 설정하세요. Hosted gateway 연결에는 필요하지 않습니다.',
    );

  let catalog;
  try {
    catalog = await loadCatalog(
      path.resolve(directory, environment.CATALOG_FILE ?? './catalog.json'),
      path.resolve(directory, environment.SOURCE_ROOT ?? './content'),
    );
    add(
      'pass',
      'catalog',
      'catalog 구조·identity·경로 규칙과 source root를 확인했습니다. 본문 파일은 읽지 않았습니다.',
    );
  } catch {
    add(
      'fail',
      'catalog',
      'CATALOG_FILE·SOURCE_ROOT 경로와 읽기 권한, 4 MiB 이하의 catalog JSON 형식을 확인하세요. 최초 설정은 npm run init을 사용하세요.',
    );
  }

  let configured;
  try {
    configured = await configuredSourcesFromEnvironment(environment);
    add('pass', 'source_configuration', '본문 공급자와 선택한 소스의 설정 형식을 확인했습니다.');
  } catch (error) {
    add(
      'fail',
      'source_configuration',
      error.code === 'ERR_MODULE_NOT_FOUND'
        ? '서비스 디렉터리에서 npm ci --ignore-scripts --no-audit --no-fund를 실행하세요.'
        : (ACTIONS[error.code] ??
            '본문 공급자와 SOURCE_ADAPTERS의 ID·origin·필드를 README.md와 ADAPTERS.md에 맞춰 확인하세요.'),
    );
  }
  if (catalog && configured) {
    try {
      createAdapterRegistry([
        ...[...catalog.sources.values()].map((source) =>
          createStaticCatalogAdapter(catalog, source, configured.contentProvider),
        ),
        ...configured.additionalAdapters,
      ]);
      const count = catalog.sources.size + configured.additionalAdapters.length;
      add(
        count ? 'pass' : 'warning',
        'sources',
        count
          ? `소스 ${count}개를 등록할 수 있습니다. 목록이나 본문은 요청하지 않았습니다.`
          : '등록한 소스가 없습니다. catalog에 작품을 넣거나 SOURCE_ADAPTERS에서 원격 소스를 선택하세요.',
      );
      const needsProvider = [...catalog.sources.values()].some((source) =>
        [...source.workMap.values()].some((work) =>
          [...work.releaseMap.values()].some((release) => release.contentUrl !== undefined),
        ),
      );
      if (needsProvider && !configured.contentProvider)
        add(
          'fail',
          'catalog_provider',
          'catalog에 contentUrl 회차가 있습니다. CONTENT_PROVIDER_ENDPOINT와 CONTENT_PROVIDER_KEY를 설정하세요.',
        );
    } catch (error) {
      add('fail', 'source_registry', ACTIONS[error.code] ?? 'catalog와 선택한 소스의 등록 계약을 확인하세요.');
    }
  }

  if (!environment.CONTENT_PROVIDER_ENDPOINT)
    add('warning', 'provider_health', '본문 공급자는 비활성입니다. 로컬 TXT만 사용한다면 설정할 필요가 없습니다.');
  else if (!configured)
    add('warning', 'provider_health', '잘못된 설정을 수정한 뒤 다시 진단하면 공급자 health를 확인합니다.');
  else {
    try {
      const endpoint = new URL(environment.CONTENT_PROVIDER_ENDPOINT);
      const health = await fetchSourceJson(new URL('/health', endpoint), {
        allowedOrigins: [endpoint.origin],
        headers: { Authorization: `Bearer ${environment.CONTENT_PROVIDER_KEY}` },
        fetchImpl,
        maxBytes: 64 * 1024,
        timeoutMs,
        stallMs: timeoutMs,
      });
      if (health?.protocol !== 1)
        add(
          'fail',
          'provider_protocol',
          '공급자 health의 protocol이 1이 아닙니다. job-v1 호환 endpoint인지 확인하세요.',
        );
      else if (health.ready !== true)
        add(
          'fail',
          'provider_ready',
          '본문 공급자가 준비되지 않았습니다. 공급자 초기화·실행 상태를 확인한 뒤 다시 진단하세요.',
        );
      else
        add(
          'pass',
          'provider_health',
          '본문 공급자의 protocol 1·ready 상태를 확인했습니다. 본문 작업은 생성하지 않았습니다.',
        );
    } catch (error) {
      add(
        'fail',
        'provider_health',
        error.code === 'source_authentication_required'
          ? '공급자 health 인증이 거부되었습니다. CONTENT_PROVIDER_KEY와 공급자의 접근 허용 설정을 확인하세요.'
          : error.code === 'source_timeout'
            ? '공급자 health 응답 시간이 초과되었습니다. 공급자의 실행 상태·방화벽·서버 간 연결을 확인하세요.'
            : '공급자 health를 확인하지 못했습니다. endpoint·접속 키·실행 상태와 job-v1 호환성을 확인하세요.',
      );
    }
  }
  await configured?.dispose?.();
  return { ok: !checks.some((check) => check.status === 'fail'), checks };
}

export function formatDiagnostics(result) {
  const labels = { pass: '통과', warning: '안내', fail: '실패' };
  return (
    result.checks.map((check) => `[${labels[check.status]}] ${check.message}`).join('\n') +
    '\n' +
    (result.ok
      ? '설정 진단을 마쳤습니다. 이 결과는 실제 회차 취득·가져오기 검증을 대신하지 않습니다.'
      : '위 설정을 수정한 뒤 npm run check를 다시 실행하세요.')
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await diagnoseSourceServer();
    console.log(formatDiagnostics(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error('진단을 완료하지 못했습니다. Node 버전·서비스 의존성과 설정 파일 읽기 권한을 확인하세요.');
    process.exitCode = 1;
  }
}
