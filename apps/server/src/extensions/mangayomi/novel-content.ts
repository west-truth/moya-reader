import { parseHTML } from 'linkedom';
import { MAX_SOURCE_TEXT_BYTES } from '../../../../../packages/extension-runtime/content-limits.mjs';

/** Convert the extension's cleaned novel fragment to the existing UTF-8 chapter contract.
 * Never mount remote markup or execute its scripts in the reader. */
export function novelHtmlText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid_source_result');
  if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error('source_body_limit');
  if (/\bWEBVIEW_BRIDGE_ERROR\b/.test(value)) throw new Error('source_connection_failed');
  const { document } = parseHTML(value);
  document.querySelectorAll('script,style,head,iframe,object,template,noscript,form').forEach((node) => node.remove());
  const chunks: string[] = [];
  const blocks = /^(P|DIV|SECTION|ARTICLE|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|TR)$/;
  const stack: (Node | string)[] = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === 'string') chunks.push(node);
    else if (node.nodeType === 3) chunks.push(node.textContent ?? '');
    else if (node.nodeName === 'BR' || node.nodeName === 'HR') chunks.push('\n');
    else {
      if (blocks.test(node.nodeName)) {
        chunks.push('\n');
        stack.push('\n');
      }
      const children = Array.from(node.childNodes);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  const text = chunks
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!text || text.includes('\0')) throw new Error('invalid_source_result');
  if (Buffer.byteLength(text) > MAX_SOURCE_TEXT_BYTES) throw new Error('source_body_limit');
  return text;
}
