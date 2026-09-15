/**
 * Finds A2UI documents inside an assistant message.
 *
 * An agent carries a document in a fenced block tagged `a2ui`, which is how it
 * reaches the chat without a tool, a server route, or a protocol extension.
 * The surrounding prose still renders as markdown, so the split has to keep
 * every segment in its original order.
 */
import { A2UI_FENCE_LANGUAGE } from './protocol';

type A2uiTextSegment =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'a2ui'; readonly source: string };

const OPEN_FENCE = new RegExp(`^\\s{0,3}\`{3,}\\s*${A2UI_FENCE_LANGUAGE}\\s*$`, 'i');
const CLOSE_FENCE = /^\s{0,3}`{3,}\s*$/;

/**
 * True when the text contains at least one opening fence, closed or not.
 *
 * Every assistant message runs this on each render, so the substring check
 * comes first: it allocates nothing, and only a message that already looks
 * like it carries a document pays for the line scan.
 */
export const hasA2uiFence = (text: string): boolean => {
  if (!text.includes(`\`\`\`${A2UI_FENCE_LANGUAGE}`)) return false;
  return text.split('\n').some((line) => OPEN_FENCE.test(line));
};

/**
 * Splits text into markdown and A2UI segments.
 *
 * An unterminated block stays markdown. While a message streams the closing
 * fence has not arrived yet, and rendering the half-written JSON would flash a
 * broken card on every delta.
 */
export const splitA2uiSegments = (text: string): readonly A2uiTextSegment[] => {
  const lines = text.split('\n');
  const segments: A2uiTextSegment[] = [];
  let markdown: string[] = [];

  const flushMarkdown = () => {
    if (markdown.length === 0) return;
    const joined = markdown.join('\n');
    if (joined.trim().length > 0) segments.push({ kind: 'markdown', text: joined });
    markdown = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (!OPEN_FENCE.test(line)) {
      markdown.push(line);
      continue;
    }

    let close = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = lines[scan];
      if (candidate !== undefined && CLOSE_FENCE.test(candidate)) {
        close = scan;
        break;
      }
    }

    if (close === -1) {
      markdown.push(line);
      continue;
    }

    flushMarkdown();
    segments.push({ kind: 'a2ui', source: lines.slice(index + 1, close).join('\n') });
    index = close;
  }

  flushMarkdown();
  return segments;
};
