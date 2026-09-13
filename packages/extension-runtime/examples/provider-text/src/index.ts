import { defineExtension, defineSource, providerText } from '@moya/extension-sdk';

// Synthetic authoring example. Real adapters validate membership using their own catalog before returning a URL.
export default defineExtension({
  sources: [
    defineSource({
      id: 'org.example.provider-text.source',
      async listWorks() {
        return { items: [{ id: 'work', title: '예제 작품' }] };
      },
      async getWork({ workId }) {
        if (workId !== 'work') throw new Error('unknown_work');
        return { id: workId, title: '예제 작품' };
      },
      async listReleases({ workId }) {
        if (workId !== 'work') throw new Error('unknown_work');
        return { items: [{ id: 'one', title: '1화', order: 1 }] };
      },
      async getContent({ workId, releaseId }) {
        if (workId !== 'work' || releaseId !== 'one') throw new Error('unknown_release');
        return providerText('https://catalog.example/work/one');
      },
    }),
  ],
});
