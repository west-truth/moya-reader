import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { PUBLIC_REQUIRED_PRODUCT_SOURCES, validatePublicFileList } from './public-release-boundary.mjs';

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: process.cwd(),
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const { violations, missing } = validatePublicFileList(tracked);

if (violations.length > 0 || missing.length > 0) {
  if (violations.length > 0) {
    console.error('공개 저장소에 금지된 추적 파일이 있습니다:');
    for (const file of violations) console.error(`- ${file}`);
  }
  if (missing.length > 0) {
    console.error('전체 제품 소스에 필요한 파일이 누락됐습니다:');
    for (const file of missing) console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(
  `공개 소스 경계 통과: tracked=${tracked.length}, native-required=${PUBLIC_REQUIRED_PRODUCT_SOURCES.length}`,
);
