import { defineExtension, defineSource } from '@moya/extension-sdk';

// This site's JSON catalog differs from the text example's locally filtered catalog.
export default defineExtension({
  sources: [
    defineSource({
      id: 'org.example.image-catalog.source',
      async listWorks({ query, cursor }, { http }) {
        const url =
          'https://catalog.example/catalog?q=' +
          encodeURIComponent(query ?? '') +
          '&cursor=' +
          encodeURIComponent(cursor ?? '');
        const data: { works: { key: string; name: string }[]; more?: string } = JSON.parse(await http.text({ url }));
        return { items: data.works.map((item) => ({ id: item.key, title: item.name })), nextCursor: data.more };
      },
      async getWork({ workId }) {
        if (workId !== 'sample') throw new Error('work_not_found');
        return { id: 'sample', title: 'Example comic' };
      },
      async listReleases({ workId, cursor }) {
        if (workId !== 'sample') throw new Error('work_not_found');
        return { items: cursor ? [] : [{ id: '1', title: 'Chapter one', order: 1 }] };
      },
      async getContent({ workId, releaseId }, { http }) {
        if (workId !== 'sample' || releaseId !== '1') throw new Error('release_not_found');
        // Array order is page order. Sequential acquisition keeps this simple example's working set bounded.
        return { kind: 'images', assets: [await http.asset({ url: 'https://catalog.example/page1.png' })] };
      },
    }),
  ],
});
