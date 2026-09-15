/**
 * Surface state for an A2UI document.
 *
 * A surface is the protocol's word for one rendering area: a map of component
 * definitions plus the data model those components bind to. The renderer owns
 * the data model while the card is on screen, because typing into a field
 * writes back to the path that field is bound to.
 */
import { z } from 'zod';

import type {
  A2uiComponent,
  A2uiDataModel,
  A2uiDynamicBoolean,
  A2uiDynamicString,
  A2uiDynamicStringList,
  A2uiJsonValue,
  A2uiMessage,
} from './protocol';

/** Rendering starts at this component id, as the specification requires. */
export const A2UI_ROOT_COMPONENT_ID = 'root';

export interface A2uiSurfaceState {
  readonly surfaceId: string;
  readonly components: ReadonlyMap<string, A2uiComponent>;
  readonly dataModel: A2uiDataModel;
}

const isJsonObject = (value: A2uiJsonValue | undefined): value is { readonly [key: string]: A2uiJsonValue } =>
  value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype;

const splitPath = (path: string): readonly string[] =>
  path.split('/').filter((segment) => segment.length > 0);

/** Reads a data-model path such as `/user/name`. Missing paths read as undefined. */
export const readPath = (dataModel: A2uiDataModel, path: string): A2uiJsonValue | undefined => {
  const segments = splitPath(path);
  let current: A2uiJsonValue | undefined = dataModel;
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
};

/**
 * Returns a copy of the data model with `path` set to `value`.
 *
 * Missing intermediate objects are created, and a non-object in the way is
 * replaced, because the alternative is silently dropping what the user typed.
 */
export const writePath = (dataModel: A2uiDataModel, path: string, value: A2uiJsonValue): A2uiDataModel => {
  const segments = splitPath(path);
  if (segments.length === 0) return isJsonObject(value) ? value : dataModel;

  const [key, ...rest] = segments;
  if (key === undefined) return dataModel;
  if (rest.length === 0) {
    return { ...dataModel, [key]: value };
  }

  const existing = dataModel[key];
  const child = isJsonObject(existing) ? existing : {};
  return { ...dataModel, [key]: writePath(child, rest.join('/'), value) };
};

const removePath = (dataModel: A2uiDataModel, path: string): A2uiDataModel => {
  const segments = splitPath(path);
  if (segments.length === 0) return {};

  const [key, ...rest] = segments;
  if (key === undefined) return dataModel;
  if (rest.length === 0) {
    const next = { ...dataModel };
    delete next[key];
    return next;
  }

  const existing = dataModel[key];
  if (!isJsonObject(existing)) return dataModel;
  return { ...dataModel, [key]: removePath(existing, rest.join('/')) };
};

const withComponents = (
  components: ReadonlyMap<string, A2uiComponent>,
  incoming: readonly A2uiComponent[],
): ReadonlyMap<string, A2uiComponent> => {
  const next = new Map(components);
  for (const component of incoming) {
    next.set(component.id, component);
  }
  return next;
};

/**
 * Folds a parsed document into its surfaces.
 *
 * Messages apply in order, so a later `updateComponents` replaces an earlier
 * definition of the same id and `deleteSurface` removes the surface outright.
 * A message for a surface that was never created still applies: refusing it
 * would turn a document that omits `createSurface` into an empty card rather
 * than the UI the agent described.
 */
export const buildSurfaces = (messages: readonly A2uiMessage[]): readonly A2uiSurfaceState[] => {
  const surfaces = new Map<string, A2uiSurfaceState>();

  const current = (surfaceId: string): A2uiSurfaceState =>
    surfaces.get(surfaceId) ?? { surfaceId, components: new Map(), dataModel: {} };

  for (const message of messages) {
    if ('createSurface' in message) {
      const { surfaceId, components, dataModel } = message.createSurface;
      const base = current(surfaceId);
      surfaces.set(surfaceId, {
        surfaceId,
        components: withComponents(base.components, components ?? []),
        dataModel: dataModel ?? base.dataModel,
      });
      continue;
    }

    if ('updateComponents' in message) {
      const { surfaceId, components } = message.updateComponents;
      const base = current(surfaceId);
      surfaces.set(surfaceId, { ...base, components: withComponents(base.components, components) });
      continue;
    }

    if ('updateDataModel' in message) {
      const { surfaceId, path, value } = message.updateDataModel;
      const base = current(surfaceId);
      const target = path ?? '/';
      const dataModel = value === undefined
        ? removePath(base.dataModel, target)
        : writePath(base.dataModel, target, value);
      surfaces.set(surfaceId, { ...base, dataModel });
      continue;
    }

    surfaces.delete(message.deleteSurface.surfaceId);
  }

  return [...surfaces.values()];
};

const jsonToDisplayString = (value: A2uiJsonValue | undefined): string => {
  if (value === undefined || value === null) return '';
  const asText = z.string().safeParse(value);
  return asText.success ? asText.data : JSON.stringify(value);
};

/** Resolves a text-valued property, following a `{ path }` binding. */
export const resolveString = (value: A2uiDynamicString | undefined, dataModel: A2uiDataModel): string => {
  if (value === undefined) return '';
  if (value.kind === 'literal') return jsonToDisplayString(value.value);
  return jsonToDisplayString(readPath(dataModel, value.path));
};

/** Resolves a boolean-valued property. A non-boolean at the bound path reads as false. */
export const resolveBoolean = (value: A2uiDynamicBoolean | undefined, dataModel: A2uiDataModel): boolean => {
  if (value === undefined) return false;
  if (value.kind === 'literal') return value.value;
  return readPath(dataModel, value.path) === true;
};

/**
 * Resolves a selection, which the protocol carries as a list even when only one
 * choice is allowed. A bound single string counts as a one-entry selection,
 * because an agent that writes `"engineer"` where a list belongs still meant
 * that option to be selected.
 */
export const resolveStringList = (
  value: A2uiDynamicStringList | undefined,
  dataModel: A2uiDataModel,
): readonly string[] => {
  if (value === undefined) return [];
  if (value.kind === 'literal') return value.value;

  const bound = readPath(dataModel, value.path);
  const asList = z.array(z.string()).safeParse(bound);
  if (asList.success) return asList.data;
  const asText = z.string().safeParse(bound);
  return asText.success ? [asText.data] : [];
};

/**
 * The data-model path a property writes to, or null when the agent inlined a
 * literal. A literal is a display value, so editing it has nowhere to go and
 * the control renders read-only rather than losing the keystroke.
 */
export const bindingPath = (
  value: A2uiDynamicString | A2uiDynamicBoolean | A2uiDynamicStringList | undefined,
): string | null => (value !== undefined && value.kind === 'binding' ? value.path : null);
