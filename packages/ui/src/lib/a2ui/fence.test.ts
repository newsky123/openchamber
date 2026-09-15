import { describe, expect, test } from 'bun:test';

import { hasA2uiFence, splitA2uiSegments } from './fence';

const fence = (body: string) => ['```a2ui', body, '```'].join('\n');

describe('splitA2uiSegments', () => {
  test('keeps prose and documents in their original order', () => {
    const segments = splitA2uiSegments(['before', fence('{"a":1}'), 'after'].join('\n'));
    expect(segments).toEqual([
      { kind: 'markdown', text: 'before' },
      { kind: 'a2ui', source: '{"a":1}' },
      { kind: 'markdown', text: 'after' },
    ]);
  });

  test('finds every document in one message', () => {
    const segments = splitA2uiSegments([fence('{"a":1}'), 'between', fence('{"b":2}')].join('\n'));
    expect(segments.filter((segment) => segment.kind === 'a2ui')).toHaveLength(2);
  });

  test('leaves an unterminated block as markdown so a streaming message never renders half a card', () => {
    const segments = splitA2uiSegments('```a2ui\n{"a":1}');
    expect(segments).toEqual([{ kind: 'markdown', text: '```a2ui\n{"a":1}' }]);
  });

  test('ignores fences of other languages', () => {
    const text = '```json\n{"a":1}\n```';
    expect(hasA2uiFence(text)).toBe(false);
    expect(splitA2uiSegments(text)).toEqual([{ kind: 'markdown', text }]);
  });

  test('drops whitespace-only prose between two documents', () => {
    const segments = splitA2uiSegments([fence('{"a":1}'), '', fence('{"b":2}')].join('\n'));
    expect(segments.every((segment) => segment.kind === 'a2ui')).toBe(true);
  });
});
