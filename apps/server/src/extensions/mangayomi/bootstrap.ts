import { mangayomiFilters } from './filters.mjs';
/** Independently implemented compatibility surface; extension code stays inside QuickJS. */
export const mangayomiBootstrap = String.raw`
let bridge, preferenceValues, preferenceChanges;
let activeRequests=0;const requestQueue=[];
function queuedRequest(method,input){return new Promise((resolve,reject)=>{if(requestQueue.length>=512){reject(new Error('compatibility_feature_unsupported'));return;}requestQueue.push({method,input,resolve,reject});drainRequests();});}
function drainRequests(){while(activeRequests<4&&requestQueue.length){const task=requestQueue.shift();activeRequests++;bridge.request(task.method,task.input).then(task.resolve,task.reject).finally(()=>{activeRequests--;drainRequests();});}}
const unsupported=()=>{const e=new Error('compatibility_feature_unsupported');e.code='compatibility_feature_unsupported';throw e;};
class MProvider {
  get source(){return sourceMetadata;}
  get supportsLatest(){return false;}
  getHeaders(){return {};}
  getFilterList(){return [];}
  getSourcePreferences(){return [];}
  substringAfter(s,p){const n=s.indexOf(p);return n<0?s:s.slice(n+p.length);}
  substringAfterLast(s,p){const n=s.lastIndexOf(p);return n<0?s:s.slice(n+p.length);}
  substringBefore(s,p){const n=s.indexOf(p);return n<0?s:s.slice(0,n);}
  substringBeforeLast(s,p){const n=s.lastIndexOf(p);return n<0?s:s.slice(0,n);}
  substringBetween(s,a,b){return this.substringBefore(this.substringAfter(s,a),b);}
}
class SharedPreferences {
  get(key){return preferenceValues[key] ?? null;}
  getString(key){const v=this.get(key);return v==null?null:String(v);}
  getBool(key){return this.get(key);}
  getBoolean(key){return this.get(key);}
  getInt(key){return this.get(key);}
  getDouble(key){return this.get(key);}
  containsKey(key){return Object.prototype.hasOwnProperty.call(preferenceValues,key);}
  set(key,value){if(typeof key!=='string'||key.length>256||!['string','boolean','number'].includes(typeof value))unsupported();preferenceValues[key]=value;preferenceChanges[key]=value;return true;}
  setString(k,v){return this.set(k,String(v));} setBool(k,v){return this.set(k,!!v);} setBoolean(k,v){return this.set(k,!!v);}
  setInt(k,v){return this.set(k,Number(v));} setDouble(k,v){return this.set(k,Number(v));}
  remove(k){delete preferenceValues[k];preferenceChanges[k]=null;return true;}
}
class Client {
  constructor(options){this.options=options||{};}
  request(method,url,headers,body){if(body!==undefined&&typeof body!=='string'){const json=Object.entries(headers||{}).some(([k,v])=>k.toLowerCase()==='content-type'&&String(v).includes('json'));body=json?JSON.stringify(body):Object.entries(body).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');headers={...(json?{}:{'Content-Type':'application/x-www-form-urlencoded'}),...headers};}return queuedRequest('compatibility.http',{method,url,headers,body});}
  get(u,h){return this.request('GET',u,h);} post(u,h,b){return this.request('POST',u,h,b);} put(u,h,b){return this.request('PUT',u,h,b);} delete(u,h,b){return this.request('DELETE',u,h,b);} head(u,h){return this.request('HEAD',u,h);}
}
class DomNode {
  constructor(node){this.node=node;}
  select(selector){return Array.from(this.node.querySelectorAll(selector),n=>new DomNode(n));}
  selectFirst(selector){const n=this.node.querySelector(selector);return n?new DomNode(n):null;}
  getElementById(id){return this.selectFirst('[id="'+String(id).replace(/["\\]/g,'\\$&')+'"]');}
  getElementsByTagName(tag){return this.select(tag);}
  attr(name){return this.node.getAttribute(name)||'';}
  get text(){return (this.node.textContent||'').replace(/\s+/g,' ').trim();}
  get ownText(){return Array.from(this.node.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim();}
  get html(){return this.node.innerHTML||'';} get outerHtml(){return this.node.outerHTML||'';}
  get children(){return Array.from(this.node.children||[],n=>new DomNode(n));}
  get parent(){return this.node.parentElement?new DomNode(this.node.parentElement):null;}
  get nextElementSibling(){return this.node.nextElementSibling?new DomNode(this.node.nextElementSibling):null;}
  get previousElementSibling(){return this.node.previousElementSibling?new DomNode(this.node.previousElementSibling):null;}
  remove(){this.node.remove();} toString(){return this.outerHtml;}
}
class Document extends DomNode {constructor(html){super(__moyaParseHTML(String(html)).document);}}
const console={log(){},warn(){},error(){},debug(){}};
let timerId=0;const timers=new Map();
function setTimeout(fn,delay,...args){if(typeof fn!=='function'||timers.size>=128)unsupported();const id=++timerId;let ms=Number(delay);if(!Number.isFinite(ms)||ms<0)ms=0;timers.set(id,{fn,args,at:Date.now()+Math.min(ms,2147483647)});return id;}
function clearTimeout(id){timers.delete(id);}
// The compatibility helper pumps these inside the same CPU/memory/deadline limits as all guest code.
// Timers never occupy HTTP RPC slots, and cancellation immediately drops the callback.
globalThis.__moyaRunTimers=()=>{const now=Date.now();const due=[...timers].filter(([,t])=>t.at<=now).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]).slice(0,32);for(const [id,t] of due){if(timers.delete(id))t.fn(...t.args);}};
const evaluate=unsupported,fetch=unsupported;
async function evaluateJavascriptViaWebview(url,headers,scripts){
  return queuedRequest('compatibility.webview',{url,headers:headers||{},scripts});
}
`;
export const mangayomiDispatch =
  `const compatibilityFilters=${mangayomiFilters.toString()};\n` +
  String.raw`
globalThis.moyaExtension=async function(method,input,host){
 bridge=host;preferenceValues=Object.assign(Object.create(null),input.preferences||{});preferenceChanges=Object.create(null);
 if(input.action==='metadata')return {result:typeof mangayomiSources==='undefined'?[]:mangayomiSources,changes:{}};
 const extension=new DefaultExtension();const specs=extension.getSourcePreferences()||[];
 for(const spec of specs){for(const name of ['editTextPreference','switchPreferenceCompat','listPreference','multiSelectListPreference']){if(spec[name]&&!Object.prototype.hasOwnProperty.call(preferenceValues,spec.key))preferenceValues[spec.key]=spec[name].value;}}
 let result;const p=input.params||{};
 if(input.action==='metadata')result=typeof mangayomiSources==='undefined'?[]:mangayomiSources;
 else if(input.action==='preferences')result=specs;
 else if(input.action==='list'){
 let filters;try{filters=await extension.getFilterList()||[];}catch(error){if(!/^getFilterList not implemented[.!]?$/.test(error.message))throw error;filters=[];}
 const definitions=compatibilityFilters(filters,p.filters||[]);
 const mode=p.query?'search':p.mode||(p.filters?.length?'search':'popular');
 let latest=false;try{latest=extension.supportsLatest===true;}catch(error){if(!/^supportsLatest not implemented[.!]?$/.test(error.message))throw error;}
 result=mode==='search'?await extension.search(p.query||'',p.page||1,filters):mode==='latest'?await extension.getLatestUpdates(p.page||1):await extension.getPopular(p.page||1);
 result.browse={activeMode:mode,availableModes:latest?['popular','latest','search']:['popular','search'],filters:definitions};
 }
 else if(input.action==='detail'||input.action==='chapters')result=await extension.getDetail(p.workUrl);
 else if(input.action==='pages'){result=await extension.getPageList(p.chapterUrl);if(Array.isArray(result))result=result.map(page=>{const url=typeof page==='string'?page:page.url;return {url,headers:(typeof page==='object'&&page.headers)||extension.getHeaders(url)||{}};});}
 else if(input.action==='html'){if(sourceMetadata.itemType!==2||typeof extension.getHtmlContent!=='function')unsupported();result=await extension.getHtmlContent(p.title,p.chapterUrl);if(typeof extension.cleanHtmlContent==='function')result=await extension.cleanHtmlContent(result);}
 else if(input.action==='headers')result=extension.getHeaders(p.url)||{};
 else unsupported();
 return {result,changes:preferenceChanges};
};
`;
