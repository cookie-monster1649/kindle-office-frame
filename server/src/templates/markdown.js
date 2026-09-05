/**
 * Markdown -> Satori element tree.
 *
 * Satori takes an element tree with inline styles, not an HTML string, and
 * supports a subset of CSS. Rather than pull in satori-html and discover its
 * gaps at render time, this walks markdown-it's token stream directly and
 * emits exactly the constructs a dashboard needs. Anything unsupported is
 * skipped rather than rendered wrongly.
 *
 * Supported: h1-h3, paragraphs, bullet and ordered lists, bold, italic,
 * inline code, soft breaks.
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false, typographer: true });

const el = (type, style, children) => ({ type, props: { style, children } });

/** Inline tokens -> an array of strings and styled spans. */
function inlineChildren(token, scale) {
  const out = [];
  const stack = [];

  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
        if (child.content) out.push(wrap(child.content, stack, scale));
        break;
      case 'strong_open':
        stack.push({ fontWeight: 700 });
        break;
      case 'em_open':
        stack.push({ fontStyle: 'italic' });
        break;
      case 'strong_close':
      case 'em_close':
        stack.pop();
        break;
      case 'code_inline':
        out.push(
          el('span', {
            fontFamily: 'monospace',
            fontSize: Math.round(28 * scale),
          }, child.content)
        );
        break;
      case 'softbreak':
      case 'hardbreak':
        out.push(' ');
        break;
      default:
        // Links, images, html_inline: nothing useful to show on this panel.
        break;
    }
  }

  return out.length ? out : [''];
}

/**
 * Inline runs become separate flex items, and flexbox trims whitespace at
 * item boundaries - so "moved to **10:30**" loses the space before the bold.
 * Pinning the boundary spaces to non-breaking keeps them, while leaving
 * interior spaces breakable so wrapping still works.
 */
function pinEdges(s) {
  const NBSP = '\u00a0';
  return s.replace(/^ /, NBSP).replace(/ $/, NBSP);
}

function wrap(content, stack, scale) {
  const pinned = pinEdges(content);
  if (!stack.length) return pinned;
  const style = Object.assign({}, ...stack);
  return el('span', style, pinned);
}

/**
 * @param {string} markdown
 * @param {number} scale  multiplier for landscape, which has more room
 */
export function markdownToTree(markdown, scale = 1) {
  const tokens = md.parse(markdown || '', {});
  const blocks = [];

  let listDepth = 0;
  let ordered = false;
  let itemIndex = 0;
  let pendingItem = null;

  const px = (n) => Math.round(n * scale);

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    switch (t.type) {
      case 'heading_open': {
        const level = t.tag;
        const inline = tokens[i + 1];
        const sizes = { h1: 58, h2: 42, h3: 34 };
        blocks.push(
          el('div', {
            display: 'flex',
            fontSize: px(sizes[level] ?? 34),
            fontWeight: 700,
            marginBottom: px(level === 'h1' ? 16 : 10),
            marginTop: blocks.length ? px(20) : 0,
            lineHeight: 1.15,
          }, inlineChildren(inline, scale))
        );
        i += 2;
        break;
      }

      case 'paragraph_open': {
        const inline = tokens[i + 1];
        const node = el('div', {
          display: 'flex',
          flexWrap: 'wrap',
          fontSize: px(32),
          lineHeight: 1.4,
          marginBottom: listDepth ? 0 : px(14),
        }, inlineChildren(inline, scale));

        if (listDepth && pendingItem) pendingItem.push(node);
        else blocks.push(node);
        i += 2;
        break;
      }

      case 'bullet_list_open':
        listDepth += 1;
        ordered = false;
        itemIndex = 0;
        break;

      case 'ordered_list_open':
        listDepth += 1;
        ordered = true;
        itemIndex = 0;
        break;

      case 'bullet_list_close':
      case 'ordered_list_close':
        listDepth -= 1;
        break;

      case 'list_item_open':
        itemIndex += 1;
        pendingItem = [];
        break;

      case 'list_item_close': {
        const marker = ordered ? `${itemIndex}.` : '•';
        blocks.push(
          el('div', {
            display: 'flex',
            flexDirection: 'row',
            marginBottom: px(8),
            marginLeft: px(14),
          }, [
            el('div', { display: 'flex', width: px(34), flexShrink: 0, fontSize: px(32) }, marker),
            el('div', { display: 'flex', flexDirection: 'column', flexGrow: 1 }, pendingItem ?? []),
          ])
        );
        pendingItem = null;
        break;
      }

      default:
        break;
    }
  }

  if (!blocks.length) {
    return [el('div', { display: 'flex', fontSize: px(30), color: '#555' }, 'No content yet.')];
  }

  return blocks;
}

export const _md = md;
