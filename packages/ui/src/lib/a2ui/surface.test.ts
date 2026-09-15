import { describe, expect, test } from 'bun:test';

import { parseA2uiDocument, type A2uiMessage } from './protocol';
import {
  bindingPath,
  buildSurfaces,
  readPath,
  resolveBoolean,
  resolveString,
  resolveStringList,
  writePath,
} from './surface';

const parse = (source: string): readonly A2uiMessage[] => {
  const result = parseA2uiDocument(source);
  if (!result.ok) throw new Error(`fixture did not parse: ${result.failure.kind}`);
  return result.messages;
};

describe('data model paths', () => {
  test('reads a nested path and reports a missing one as undefined', () => {
    const model = { user: { name: 'Ada' } };
    expect(readPath(model, '/user/name')).toBe('Ada');
    expect(readPath(model, '/user/email')).toBeUndefined();
  });

  test('creates missing intermediate objects rather than dropping the value', () => {
    expect(writePath({}, '/user/name', 'Ada')).toEqual({ user: { name: 'Ada' } });
  });

  test('replaces a non-object standing where an object is needed', () => {
    expect(writePath({ user: 'Ada' }, '/user/name', 'Ada')).toEqual({ user: { name: 'Ada' } });
  });

  test('leaves unrelated branches untouched', () => {
    expect(writePath({ a: 1, user: { name: 'Ada', age: 36 } }, '/user/name', 'Grace'))
      .toEqual({ a: 1, user: { name: 'Grace', age: 36 } });
  });
});

describe('buildSurfaces', () => {
  test('applies messages in order, so a later definition wins', () => {
    const [surface] = buildSurfaces(parse(JSON.stringify([
      { version: 'v1.0', createSurface: { surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'first' }] } },
      { version: 'v1.0', updateComponents: { surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'second' }] } },
    ])));
    const root = surface?.components.get('root');
    expect(root?.component === 'Text' ? resolveString(root.text, {}) : null).toBe('second');
  });

  test('renders a document that never sent createSurface', () => {
    const [surface] = buildSurfaces(parse(JSON.stringify([
      { version: 'v1.0', updateComponents: { surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'hi' }] } },
    ])));
    expect(surface?.components.has('root')).toBe(true);
  });

  test('updateDataModel without a value removes the path', () => {
    const [surface] = buildSurfaces(parse(JSON.stringify([
      { version: 'v1.0', createSurface: { surfaceId: 's', dataModel: { keep: 1, drop: 2 } } },
      { version: 'v1.0', updateDataModel: { surfaceId: 's', path: '/drop' } },
    ])));
    expect(surface?.dataModel).toEqual({ keep: 1 });
  });

  test('deleteSurface removes the surface entirely', () => {
    const surfaces = buildSurfaces(parse(JSON.stringify([
      { version: 'v1.0', createSurface: { surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'hi' }] } },
      { version: 'v1.0', deleteSurface: { surfaceId: 's' } },
    ])));
    expect(surfaces).toHaveLength(0);
  });

  test('keeps independent surfaces apart', () => {
    const surfaces = buildSurfaces(parse(JSON.stringify([
      { version: 'v1.0', createSurface: { surfaceId: 'a', dataModel: { v: 1 } } },
      { version: 'v1.0', createSurface: { surfaceId: 'b', dataModel: { v: 2 } } },
    ])));
    expect(surfaces.map((surface) => surface.dataModel.v)).toEqual([1, 2]);
  });
});

describe('value resolution', () => {
  const model = { name: 'Ada', notify: true, roles: ['engineer'], count: 3 };
  const bind = (path: string) => ({ kind: 'binding' as const, path });

  test('follows a binding and passes a literal through', () => {
    expect(resolveString(bind('/name'), model)).toBe('Ada');
    expect(resolveString({ kind: 'literal', value: 'literal' }, model)).toBe('literal');
  });

  test('renders a bound number as text', () => {
    expect(resolveString(bind('/count'), model)).toBe('3');
  });

  test('reads a missing binding as empty rather than as the word undefined', () => {
    expect(resolveString(bind('/missing'), model)).toBe('');
  });

  test('treats a non-boolean at a boolean path as false', () => {
    expect(resolveBoolean(bind('/notify'), model)).toBe(true);
    expect(resolveBoolean(bind('/name'), model)).toBe(false);
  });

  test('accepts a single bound string as a one-entry selection', () => {
    expect(resolveStringList(bind('/roles'), model)).toEqual(['engineer']);
    expect(resolveStringList(bind('/name'), model)).toEqual(['Ada']);
  });

  test('reports the write target only for a binding', () => {
    expect(bindingPath(bind('/name'))).toBe('/name');
    expect(bindingPath({ kind: 'literal', value: 'Ada' })).toBeNull();
    expect(bindingPath(undefined)).toBeNull();
  });
});
