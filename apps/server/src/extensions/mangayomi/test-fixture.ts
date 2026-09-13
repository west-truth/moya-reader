export const fixtureRow = {
  id: 123,
  name: 'Image novel',
  lang: 'ko',
  version: '1.0.0',
  baseUrl: 'https://site.example',
  sourceCodeUrl: 'https://repo.example/source.js',
  sourceCodeLanguage: 1,
  itemType: 0,
};
export const fixtureSource = `class DefaultExtension extends MProvider{
 getSourcePreferences(){return [{key:'enabled',switchPreferenceCompat:{title:'Use provider',value:false}},{key:'endpoint',editTextPreference:{title:'Provider URL',value:''}},{key:'access_key',editTextPreference:{title:'Access key',value:''}}];}
 async getPopular(){const doc=new Document('<section><a href="/work/1"><b>Novel</b> image</a></section>');const a=doc.selectFirst('section a[href]');return {list:[{name:a.text,link:a.attr('href')}],hasNextPage:false};}
 async getDetail(){return {name:'Novel',chapters:[{name:'Two',url:'/2'},{name:'One',url:'/1'}]};}
 async getPageList(){const prefs=new SharedPreferences();const endpoint=prefs.getString('endpoint');await new Client().post(endpoint+'/jobs',{'Authorization':'Bearer '+prefs.getString('access_key'),'Content-Type':'application/json'},{chapter:'one'});await new Promise(resolve=>setTimeout(resolve,5));await new Client().post(endpoint+'/close',{},{});return [{url:'https://site.example/image.jpg',headers:{Referer:'https://site.example/1'}}];}
}`;
