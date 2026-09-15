# A2UI in chat

## What this is

A2UI is an open protocol for agent-driven interfaces: the agent sends a
declarative JSON component tree plus the data model it binds to, and the client
renders it with its own components. No code from the agent runs in the client.

OpenChamber renders A2UI documents that an assistant writes into its answer, so
a request like "build me a feedback form" produces a card you can type into
rather than a JSON code block.

Only protocol version `v1.0` is accepted. Earlier drafts renamed every message
(v0.8 used `beginRendering` and `surfaceUpdate`, v0.9 introduced the current
names), so a document that declares another version shows a one-line notice
instead of being rendered under the wrong semantics.

## How a document reaches the screen

1. The agent writes a fenced block tagged `a2ui` into a text part.
2. `lib/a2ui/fence.ts` splits the message into markdown and A2UI segments,
   preserving their order.
3. `lib/a2ui/protocol.ts` parses one block. This is the only place an agent
   payload becomes a typed value.
4. `lib/a2ui/surface.ts` folds the parsed messages into surfaces.
5. `A2uiSurfaceView` renders one surface and owns its data model while the card
   is on screen.

`chat/message/parts/AssistantTextPart.tsx` is the single entry point. Nothing
else detects or renders A2UI.

## Files

- `lib/a2ui/protocol.ts`: zod schemas, the closed component catalog, and
  `parseA2uiDocument`.
- `lib/a2ui/surface.ts`: surface state, data-model paths, and value resolution.
- `lib/a2ui/fence.ts`: finds documents inside an assistant message.
- `A2uiBlock.tsx`: one document, or the notice explaining why it did not render.
- `A2uiSurfaceView.tsx`: data-model state, actions, and the result panel.
- `A2uiNode.tsx`: the recursive component renderer.
- `a2uiRenderContext.ts`: what the recursion shares.
- `fixtures/feedback-form.a2ui.json`: the sample document.

## Invariants

- **Parse at the boundary, branch on the domain value.** A property is either
  `{ kind: 'literal' }` or `{ kind: 'binding' }` by the time it leaves
  `protocol.ts`. Renderers never inspect the wire shape to work out which one
  the agent wrote.
- **The catalog is closed.** A component this module does not implement renders
  as a named placeholder. A known component whose properties are malformed
  lands in the same placeholder, so one bad definition never costs the rest of
  the card.
- **A failed document never falls back to its payload.** The JSON is the
  agent's wire format, not something a reader of the conversation asked to see.
- **Nothing renders while the message streams.** The closing fence has not
  arrived yet, so a half-written document would flash a broken card on every
  delta. `AssistantTextPart` skips the scan while streaming, and an
  unterminated block stays markdown.
- **The user owns the data model after the first paint.** The document supplies
  the initial values; every keystroke after that belongs to the person typing.
  State resets only when the surface identity changes.
- **A literal-valued control is read-only.** Editing it would have nowhere to
  write, and losing the keystroke silently is worse than showing it disabled.
- **Documents are bounded.** 128 KiB of source, 50 messages, 200 components,
  and a depth cap of 24 in the renderer. A surface renders inside the chat
  timeline, where an oversized payload costs every message list render, and a
  component tree is a map of ids that can reference itself in a cycle.

## Catalog

`Text`, `Divider`, `Row`, `Column`, `Card`, `Button`, `TextField`, `CheckBox`,
`ChoicePicker`.

Each maps onto an existing primitive from `components/ui`, so a card inherits
the app's tokens, spacing and themes. Adding a component means adding its
schema to the discriminated union in `protocol.ts` and its branch in
`A2uiNode.tsx`; there is no registry to update.

Not implemented: `Image`, `Icon`, `Video`, `AudioPlayer`, `List`, `Tabs`,
`Modal`, `Slider`, `DateTimeInput`, template-bound children, function-call
expressions, and `checks` validation rules. They render as placeholders rather
than being silently dropped.

## What a button does

A `Button` action collects the resolved action context and the whole data
model, and shows them under the card with a copy control. The protocol's
`userAction` message only carries the declared context, but a person reading
the card wants the values they just entered: an agent that forgets to declare
context would otherwise produce an empty result for a form they just filled in.

The result is not sent back to the agent. Wiring a submit into the composer or
into a blocking tool call is a separate change, deliberately not made here.

## Running the sample

`fixtures/feedback-form.a2ui.json` is a form with a text field, a choice
picker, a checkbox, a long-text field and a submit button, all bound to the
data model.

Rendered, with assertions, by `A2uiSurfaceView.test.tsx`:

```
bun test --cwd packages/ui src/components/a2ui src/lib/a2ui
```

To see it in a real conversation, ask the agent to repeat the file's contents
inside a fenced block tagged `a2ui`. The card appears in place of the block,
and the fields work.
