import { describe, expect, it } from 'vitest';
import { invokeMangayomi } from './runtime.js';
import { novelHtmlText } from './novel-content.js';
import {
  parseMangayomiIndex,
  detectCompatibilityRepository,
} from '../../../../../packages/extension-contracts/compatibility-repository.js';
import { preferenceSchema } from './preferences.js';
import { parseMangaApkIndex } from '../../../../../packages/extension-contracts/apk-repository.js';
import { validateRepositoryIndex } from '../../../../../src/extensions/packages/repository-contract.js';

import { fixtureRow, fixtureSource } from './test-fixture.js';
describe('Mangayomi compatibility runtime', () => {
  it('does not save empty markup or a WebView bridge failure as a novel chapter', () => {
    expect(() => novelHtmlText('<script>ignored()</script><img src="cover.jpg">')).toThrow('invalid_source_result');
    expect(() => novelHtmlText('<h2>Chapter</h2><p>WEBVIEW_BRIDGE_ERROR</p>')).toThrow('source_connection_failed');
    expect(novelHtmlText('<p>&lt;안녕&gt; <em>세계</em></p>')).toBe('<안녕> 세계');
  });
  it('distinguishes novel metadata from manga and rejects video extensions', () => {
    const entries = parseMangayomiIndex([fixtureRow, { ...fixtureRow, id: 124, itemType: 2, isManga: false }]);
    expect(entries.map((entry) => [entry.itemType, entry.isManga])).toEqual([
      [0, true],
      [2, false],
    ]);
    expect(() => parseMangayomiIndex([{ ...fixtureRow, itemType: 1, isManga: false }])).toThrow();
  });
  it('runs maker-declared optional WebView behavior without inventing a service requirement', async () => {
    const browserCalls: unknown[] = [];
    const source = `class DefaultExtension extends MProvider {
      getSourcePreferences(){return [{key:'render',switchPreference:{title:'Render page',value:false}}]}
      async getPopular(){if(new SharedPreferences().getBool('render'))await evaluateJavascriptViaWebview('https://site.example',{},['document.title']);return {list:[],hasNextPage:false}}
    }`;
    for (const render of [false, true])
      await invokeMangayomi({
        entry: parseMangayomiIndex([fixtureRow])[0],
        source,
        action: 'list',
        preferences: { render },
        signal: AbortSignal.timeout(3000),
        webview: async (request) => {
          browserCalls.push(request);
          return true;
        },
      });
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0]).toMatchObject({ url: 'https://site.example', timeoutMs: 25000 });
  });
  it('keeps safe connection diagnostics when the original script replaces a transport error', async () => {
    await expect(
      invokeMangayomi(
        {
          entry: parseMangayomiIndex([fixtureRow])[0],
          source: `class DefaultExtension extends MProvider {async getPopular(){
            try {await new Client().get('https://site.example/work');}
            catch {throw new Error('Upstream response with private details');}
          }}`,
          action: 'list',
          signal: AbortSignal.timeout(2000),
        },
        async () => {
          throw new Error('source_connection_failed');
        },
      ),
    ).rejects.toThrow(/^source_connection_failed$/);
  });
  it('clears request timeout timers without leaving sleeping RPCs ahead of later requests', async () => {
    const value = await invokeMangayomi(
      {
        entry: parseMangayomiIndex([fixtureRow])[0],
        source: `class DefaultExtension extends MProvider {async getPopular(){
        const list=[];
        for(let i=0;i<12;i++){
          let timer;
          const response=await Promise.race([
            new Client().get('https://site.example/'+i),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('late timeout')),5000);})
          ]);
          clearTimeout(timer);list.push(response.statusCode);
        }
        return {list,hasNextPage:false};
      }}`,
        action: 'list',
        signal: AbortSignal.timeout(2000),
      },
      async (input) => ({
        bytes: Buffer.from('{}'),
        statusCode: 200,
        headers: {},
        contentType: 'application/json',
        url: input.url,
      }),
    );
    expect(value.result).toMatchObject({ list: Array(12).fill(200), hasNextPage: false });
  });
  it('fires timers while HTTP requests are pending and supports callback arguments and cancellation', async () => {
    const value = await invokeMangayomi(
      {
        entry: parseMangayomiIndex([fixtureRow])[0],
        source: `class DefaultExtension extends MProvider {async getPopular(){
        const cancelled=setTimeout(()=>{throw new Error('cancelled timer fired');},1);clearTimeout(cancelled);
        const long=setTimeout(()=>{throw new Error('long timer fired');},12000);clearTimeout(long);
        const first=await Promise.race([new Client().get('https://site.example/slow'),new Promise(resolve=>setTimeout(resolve,20,'timer'))]);
        return {list:[first],hasNextPage:false};
      }}`,
        action: 'list',
        signal: AbortSignal.timeout(2000),
      },
      async (input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 150);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        });
        return {
          bytes: Buffer.from('{}'),
          statusCode: 200,
          headers: {},
          contentType: 'application/json',
          url: input.url,
        };
      },
    );
    expect(value.result).toMatchObject({ list: ['timer'], hasNextPage: false });
  });
  it('queues original Promise.all requests within the existing four-RPC bound', async () => {
    let active = 0,
      peak = 0,
      count = 0;
    const value = await invokeMangayomi(
      {
        entry: parseMangayomiIndex([fixtureRow])[0],
        source: `class DefaultExtension extends MProvider {async getPopular(){const list=await Promise.all(Array.from({length:12},(_,i)=>new Client().get('https://site.example/'+i)));return {list,hasNextPage:false};}}`,
        action: 'list',
        signal: AbortSignal.timeout(10000),
      },
      async (input) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        count++;
        return {
          bytes: Buffer.from('{}'),
          statusCode: 200,
          headers: {},
          contentType: 'application/json',
          url: input.url,
        };
      },
    );
    expect((value.result as { list: unknown[] }).list).toHaveLength(12);
    expect(count).toBe(12);
    expect(peak).toBe(4);
  });
  it('detects code format, rejects mixed/ambiguous catalogs and unsafe numeric IDs', () => {
    expect(detectCompatibilityRepository([fixtureRow])).toBe('mangayomi');
    expect(() => parseMangaApkIndex([fixtureRow])).toThrow('compatibility_repository_mismatch');
    expect(() => validateRepositoryIndex([fixtureRow], 'https://repo.example/index.json')).toThrow(
      'package_repository_mangayomi',
    );
    expect(parseMangayomiIndex([fixtureRow])[0].format).toBe('mangayomi-js');
    expect(parseMangayomiIndex([{ ...fixtureRow, sourceCodeLanguage: 0 }])[0].format).toBe('mangayomi-dart');
    expect(detectCompatibilityRepository([fixtureRow, { pkg: 'a', apk: 'a.apk', sources: [] }])).toBeUndefined();
    expect(() => parseMangayomiIndex([{ ...fixtureRow, id: Number.MAX_SAFE_INTEGER + 1 }])).toThrow();
  });
  it('runs synchronous DOM, generic preferences and an authenticated provider sequence inside QuickJS', async () => {
    const entry = parseMangayomiIndex([fixtureRow])[0],
      signal = new AbortController().signal;
    const specs = await invokeMangayomi({ entry, source: fixtureSource, action: 'preferences', signal });
    expect(preferenceSchema(specs.result)[2].secret).toBe(true);
    const listing = await invokeMangayomi({ entry, source: fixtureSource, action: 'list', signal });
    expect(listing.result).toMatchObject({ list: [{ name: 'Novel image', link: '/work/1' }], hasNextPage: false });
    const calls: string[] = [];
    const pages = await invokeMangayomi(
      {
        entry,
        source: fixtureSource,
        action: 'pages',
        preferences: { enabled: true, endpoint: 'http://127.0.0.1:9870', access_key: 'private-fixture' },
        signal,
      },
      async (input) => {
        calls.push(input.url);
        if (input.url.endsWith('/jobs')) expect(input.headers?.Authorization).toBe('Bearer private-fixture');
        return {
          bytes: Buffer.from('{}'),
          statusCode: 200,
          headers: {},
          contentType: 'application/json',
          url: input.url,
        };
      },
    );
    expect(calls).toEqual(['http://127.0.0.1:9870/jobs', 'http://127.0.0.1:9870/close']);
    expect(pages.result).toHaveLength(1);
  });
});

it('preserves maker filter fields and applies grouped state and sort to an empty-query search', async () => {
  const source = `class DefaultExtension extends MProvider {
    get supportsLatest(){return true}
    getFilterList(){return [
      {type_name:'SelectFilter',name:'Order',state:0,values:[{name:'Old',value:'old'},{name:'New',value:'new'}]},
      {type_name:'GroupFilter',name:'Tags',state:[{type_name:'TriState',name:'Tag',value:'tag'}]},
      {type_name:'SortFilter',name:'Sort',values:['Title','Date'],state:{index:0,ascending:false}}
    ]}
    async search(query,page,filters){return {list:[{name:JSON.stringify([query,page,filters]),link:'/1'}],hasNextPage:true}}
    async getLatestUpdates(){return {list:[],hasNextPage:false}}
  }`;
  const result = await invokeMangayomi({
    entry: parseMangayomiIndex([fixtureRow])[0],
    source,
    action: 'list',
    params: {
      page: 2,
      filters: [
        { position: 0, value: 1 },
        { position: 1, groupPosition: 0, value: 'EXCLUDE' },
        { position: 2, value: { index: 1, ascending: true } },
      ],
    },
    signal: AbortSignal.timeout(5000),
  });
  const value = result.result as { list: { name: string }[]; browse: { activeMode: string; filters: unknown[] } };
  const [query, page, filters] = JSON.parse(value.list[0].name);
  expect([query, page]).toEqual(['', 2]);
  expect(filters[0]).toMatchObject({ state: 1, values: [{ value: 'old' }, { value: 'new' }] });
  expect(filters[1].state[0]).toMatchObject({ value: 'tag', state: 2 });
  expect(filters[2].state).toEqual({ index: 1, ascending: true });
  expect(value.browse.activeMode).toBe('search');
  const latest = await invokeMangayomi({
    entry: parseMangayomiIndex([fixtureRow])[0],
    source,
    action: 'list',
    params: { mode: 'latest', filters: [{ position: 0, value: 0 }] },
    signal: AbortSignal.timeout(5000),
  });
  expect(latest.result).toMatchObject({
    browse: { activeMode: 'latest', availableModes: ['popular', 'latest', 'search'] },
  });
});

it('does not break existing popular browsing on a maker template latest stub', async () => {
  const value = await invokeMangayomi({
    entry: parseMangayomiIndex([fixtureRow])[0],
    action: 'list',
    signal: AbortSignal.timeout(5000),
    source: `class DefaultExtension extends MProvider {get supportsLatest(){throw new Error('supportsLatest not implemented')} async getPopular(){return {list:[],hasNextPage:false}}}`,
  });
  expect(value.result).toMatchObject({ browse: { activeMode: 'popular', availableModes: ['popular', 'search'] } });
});
