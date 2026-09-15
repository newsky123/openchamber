import { describe, expect, test } from 'bun:test';

import { A2UI_MAX_SOURCE_BYTES, parseA2uiDocument } from './protocol';

const message = (body: string) => `{"version":"v1.0",${body}}`;

const surfaceWithText = message('"createSurface":{"surfaceId":"s","components":[{"id":"root","component":"Text","text":"hi"}]}');

describe('parseA2uiDocument', () => {
  test('accepts a single v1.0 message', () => {
    const result = parseA2uiDocument(surfaceWithText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toHaveLength(1);
  });

  test('accepts an array of messages', () => {
    const result = parseA2uiDocument(`[${surfaceWithText},${message('"updateDataModel":{"surfaceId":"s","path":"/a","value":1}')}]`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages).toHaveLength(2);
  });

  test('names the version of a document written against another revision', () => {
    const result = parseA2uiDocument('{"version":"v0.9","createSurface":{"surfaceId":"s","catalogId":"basic"}}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ kind: 'unsupported-version', version: 'v0.9' });
  });

  test('rejects a message with no version at all', () => {
    const result = parseA2uiDocument('{"createSurface":{"surfaceId":"s"}}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-document');
  });

  test('reports malformed JSON separately from a malformed document', () => {
    const broken = parseA2uiDocument('{"version":');
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.failure.kind).toBe('invalid-json');
  });

  test('refuses a document larger than the cap', () => {
    const result = parseA2uiDocument('x'.repeat(A2UI_MAX_SOURCE_BYTES + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('too-large');
  });

  test('refuses more components than one card may carry', () => {
    const components = Array.from({ length: 201 }, (_, index) => `{"id":"c${index}","component":"Text","text":"x"}`);
    const result = parseA2uiDocument(message(`"updateComponents":{"surfaceId":"s","components":[${components.join(',')}]}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('too-large');
  });

  test('keeps an unimplemented component as a placeholder instead of failing the document', () => {
    const result = parseA2uiDocument(message(
      '"updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Text","text":"hi"},{"id":"v","component":"Video","url":"https://example.com/a.mp4"}]}',
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first] = result.messages;
    expect(first && 'updateComponents' in first ? first.updateComponents.components[1] : null)
      .toEqual({ id: 'v', component: 'Unsupported', name: 'Video' });
  });

  test('treats a known component with malformed properties as a placeholder', () => {
    const result = parseA2uiDocument(message('"updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Text"}]}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first] = result.messages;
    expect(first && 'updateComponents' in first ? first.updateComponents.components[0] : null)
      .toEqual({ id: 'root', component: 'Unsupported', name: 'Text' });
  });
});
