import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StorageUsageDetails } from './StorageUsageDetails';
import { StorageCapacityCard } from './StorageCapacityCard';

describe('storage capacity display', () => {
  it('distinguishes unavailable from zero space and shows low capacity honestly', () => {
    const unavailable = renderToStaticMarkup(
      <StorageCapacityCard capacity={{ status: 'unavailable', reason: 'read_failed' }} />,
    );
    expect(unavailable).toContain('확인하지 못했습니다');
    expect(unavailable).not.toContain('role="meter"');
    const zero = renderToStaticMarkup(
      <StorageCapacityCard
        capacity={{ status: 'available', totalBytes: 1024 ** 3, availableBytes: 0, minimumFreeBytes: 100 }}
      />,
    );
    expect(zero).toContain('0 B');
    expect(zero).toContain('얼마 남지 않았습니다');
    expect(zero).toContain('aria-valuenow="1073741824"');
  });
  it('keeps categories and device caches separate; memory caches are not reported as stored files', () => {
    const markup = renderToStaticMarkup(
      <StorageUsageDetails
        usage={{
          books: [],
          totalBytes: 2048,
          libraryBytes: 2048,
          trashBytes: 0,
          breakdown: { text: 1024, ebook: 0, comic: 0, image: 1024, audio: 0, other: 0 },
        }}
      />,
    );
    expect(markup).toContain('사용량 상세');
    expect(markup).toContain('1.0 KiB');
    expect(markup).toContain('표지·이미지');
    expect(markup).not.toContain('기기 목록 캐시'); // Measured on expansion, not every settings visit.
  });
});
