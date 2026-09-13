import { defineExtension, defineSource } from '@moya/extension-sdk';

// All data in this example is synthetic. IDs must remain stable across searches and releases.
const work = { id: 'sample', title: 'Example novel', author: 'Example author' };
export default defineExtension({
  sources: [
    defineSource({
      id: 'org.example.text-catalog.source',
      async listWorks({ query, cursor }) {
        return { items: cursor || (query && !work.title.toLowerCase().includes(query.toLowerCase())) ? [] : [work] };
      },
      async getWork({ workId }) {
        if (workId !== work.id) throw new Error('work_not_found');
        return work;
      },
      async listReleases({ workId, cursor }) {
        if (workId !== work.id) throw new Error('work_not_found');
        return { items: cursor ? [] : [{ id: '1', title: 'Chapter one', number: 1, order: 1 }] };
      },
      async getContent({ workId, releaseId }, { http }) {
        if (workId !== work.id || releaseId !== '1') throw new Error('release_not_found');
        return { kind: 'text', asset: await http.asset({ url: 'https://catalog.example/chapter.txt' }) };
      },
    }),
  ],
});
