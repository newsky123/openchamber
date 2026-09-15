/**
 * A2UI v1.0 wire format.
 *
 * An agent writes A2UI messages into its answer and OpenChamber renders them
 * as an interactive card. The payload is agent output, so it is untrusted
 * input on the chat render path: this module is the only place it becomes a
 * typed value, and nothing downstream re-validates or casts it.
 *
 * Only `v1.0` is accepted. Earlier drafts renamed every message (v0.8 used
 * `beginRendering`/`surfaceUpdate`, v0.9 introduced the current names), so
 * sniffing shapes instead of reading the version string would silently render
 * a document written against different semantics.
 */
import { z } from 'zod';

const A2UI_VERSION = 'v1.0';

/** The fence language an assistant message uses to carry a document. */
export const A2UI_FENCE_LANGUAGE = 'a2ui';

/**
 * Bounds for one document. A surface renders inside the chat timeline, where
 * an oversized payload costs every message list render, so the parser refuses
 * rather than the renderer coping.
 */
export const A2UI_MAX_SOURCE_BYTES = 128 * 1024;
const A2UI_MAX_MESSAGES = 50;
const A2UI_MAX_COMPONENTS = 200;

/** Any value the data model can hold. */
export type A2uiJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly A2uiJsonValue[]
  | { readonly [key: string]: A2uiJsonValue };

export type A2uiDataModel = { readonly [key: string]: A2uiJsonValue };

const jsonValueSchema: z.ZodType<A2uiJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const dataModelSchema = z.record(z.string(), jsonValueSchema);

/**
 * A value the agent binds to the data model instead of writing inline.
 *
 * The wire format is `"literal"` or `{ "path": "/a/b" }`, two shapes that
 * every renderer would otherwise have to tell apart by inspecting the value.
 * Parsing resolves that here, so the rest of the code branches on a discriminant
 * instead of re-deriving what the agent meant at each use.
 */
const bindingSchema = z.object({ path: z.string().min(1) })
  .transform((value) => ({ kind: 'binding' as const, path: value.path }));

const literal = <Schema extends z.ZodType>(schema: Schema) =>
  schema.transform((value) => ({ kind: 'literal' as const, value }));

const dynamicStringSchema = z.union([
  literal(z.union([z.string(), z.number(), z.boolean()])),
  bindingSchema,
]);
const dynamicBooleanSchema = z.union([literal(z.boolean()), bindingSchema]);
const dynamicStringListSchema = z.union([literal(z.array(z.string())), bindingSchema]);

export type A2uiDynamicString = z.infer<typeof dynamicStringSchema>;
export type A2uiDynamicBoolean = z.infer<typeof dynamicBooleanSchema>;
export type A2uiDynamicStringList = z.infer<typeof dynamicStringListSchema>;

const alignSchema = z.enum(['start', 'center', 'end', 'stretch']);
const justifySchema = z.enum(['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch']);

const actionSchema = z.object({
  name: z.string().min(1),
  context: z.record(z.string(), dynamicStringSchema).optional(),
});

const choiceOptionSchema = z.object({
  label: dynamicStringSchema,
  value: z.string(),
});

const componentId = z.string().min(1);

/**
 * The catalog OpenChamber renders. It is closed on purpose: a component that
 * is not listed here renders as a named placeholder, never as raw content.
 */
const knownComponentSchema = z.discriminatedUnion('component', [
  z.object({
    id: componentId,
    component: z.literal('Text'),
    text: dynamicStringSchema,
    variant: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'body', 'caption']).optional(),
  }),
  z.object({
    id: componentId,
    component: z.literal('Divider'),
    axis: z.enum(['horizontal', 'vertical']).optional(),
  }),
  z.object({
    id: componentId,
    component: z.literal('Row'),
    children: z.array(componentId),
    align: alignSchema.optional(),
    justify: justifySchema.optional(),
  }),
  z.object({
    id: componentId,
    component: z.literal('Column'),
    children: z.array(componentId),
    align: alignSchema.optional(),
    justify: justifySchema.optional(),
  }),
  z.object({
    id: componentId,
    component: z.literal('Card'),
    child: componentId,
  }),
  z.object({
    id: componentId,
    component: z.literal('Button'),
    child: componentId,
    action: actionSchema,
    primary: z.boolean().optional(),
  }),
  z.object({
    id: componentId,
    component: z.literal('TextField'),
    label: dynamicStringSchema,
    value: dynamicStringSchema.optional(),
    variant: z.enum(['shortText', 'longText', 'number', 'obscured']).optional(),
  }),
  z.object({
    id: componentId,
    component: z.literal('CheckBox'),
    label: dynamicStringSchema,
    value: dynamicBooleanSchema,
  }),
  z.object({
    id: componentId,
    component: z.literal('ChoicePicker'),
    options: z.array(choiceOptionSchema).min(1),
    value: dynamicStringListSchema,
    label: dynamicStringSchema.optional(),
    variant: z.enum(['mutuallyExclusive', 'multipleSelection']).optional(),
  }),
]);

/**
 * Anything else with an id and a component name. A document that names one
 * component we do not implement still renders every component we do, which is
 * why this is a variant rather than a parse failure. A known component whose
 * own properties are malformed also lands here and shows the same placeholder.
 */
const unknownComponentSchema = z.object({
  id: componentId,
  component: z.string().min(1),
}).transform((value) => ({ id: value.id, component: 'Unsupported' as const, name: value.component }));

const componentSchema = z.union([knownComponentSchema, unknownComponentSchema]);

export type A2uiComponent = z.infer<typeof componentSchema>;

const versionSchema = z.literal(A2UI_VERSION);

const messageSchema = z.union([
  z.object({
    version: versionSchema,
    createSurface: z.object({
      surfaceId: z.string().min(1),
      catalogId: z.string().optional(),
      components: z.array(componentSchema).optional(),
      dataModel: dataModelSchema.optional(),
    }),
  }),
  z.object({
    version: versionSchema,
    updateComponents: z.object({
      surfaceId: z.string().min(1),
      components: z.array(componentSchema),
    }),
  }),
  z.object({
    version: versionSchema,
    updateDataModel: z.object({
      surfaceId: z.string().min(1),
      path: z.string().optional(),
      value: jsonValueSchema.optional(),
    }),
  }),
  z.object({
    version: versionSchema,
    deleteSurface: z.object({ surfaceId: z.string().min(1) }),
  }),
]);

export type A2uiMessage = z.infer<typeof messageSchema>;

type A2uiParseFailure =
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'unsupported-version'; readonly version: string }
  | { readonly kind: 'invalid-document' };

type A2uiParseResult =
  | { readonly ok: true; readonly messages: readonly A2uiMessage[] }
  | { readonly ok: false; readonly failure: A2uiParseFailure };

const versionProbeSchema = z.object({ version: z.string() });

const readVersion = (value: A2uiJsonValue): string | null => {
  const probed = versionProbeSchema.safeParse(value);
  return probed.success ? probed.data.version : null;
};

/**
 * Reports the version a document declares, so an unsupported one can say which
 * version it is instead of reading as malformed JSON.
 */
const findForeignVersion = (documents: readonly A2uiJsonValue[]): string | null => {
  for (const document of documents) {
    const version = readVersion(document);
    if (version !== null && version !== A2UI_VERSION) return version;
  }
  return null;
};

const countComponents = (messages: readonly A2uiMessage[]): number => {
  let total = 0;
  for (const message of messages) {
    if ('createSurface' in message) total += message.createSurface.components?.length ?? 0;
    else if ('updateComponents' in message) total += message.updateComponents.components.length;
  }
  return total;
};

/**
 * Parses one fenced block into messages.
 *
 * Accepts a single message or an array of them, because an agent writing a
 * surface and its data in one block produces the array form and both appear in
 * the specification's own examples.
 */
export const parseA2uiDocument = (source: string): A2uiParseResult => {
  if (source.length > A2UI_MAX_SOURCE_BYTES) {
    return { ok: false, failure: { kind: 'too-large' } };
  }

  let raw: A2uiJsonValue;
  try {
    // SAFETY: JSON.parse produces exactly the values A2uiJsonValue enumerates,
    // and every field is validated against the message schema below before any
    // of it is read.
    raw = JSON.parse(source) as A2uiJsonValue;
  } catch {
    return { ok: false, failure: { kind: 'invalid-json' } };
  }

  const documents = Array.isArray(raw) ? raw : [raw];
  if (documents.length === 0 || documents.length > A2UI_MAX_MESSAGES) {
    return { ok: false, failure: { kind: 'invalid-document' } };
  }

  const parsed = z.array(messageSchema).safeParse(documents);
  if (!parsed.success) {
    const foreignVersion = findForeignVersion(documents);
    if (foreignVersion !== null) {
      return { ok: false, failure: { kind: 'unsupported-version', version: foreignVersion } };
    }
    return { ok: false, failure: { kind: 'invalid-document' } };
  }

  if (countComponents(parsed.data) > A2UI_MAX_COMPONENTS) {
    return { ok: false, failure: { kind: 'too-large' } };
  }

  return { ok: true, messages: parsed.data };
};
