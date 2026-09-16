import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { parseA2uiDocument } from '@/lib/a2ui/protocol';
import { buildSurfaces } from '@/lib/a2ui/surface';

const sampleSource = `[
  {"version":"v1.0","createSurface":{"surfaceId":"s","dataModel":{"role":["engineer"],"agree":false}}},
  {"version":"v1.0","updateComponents":{"surfaceId":"s","components":[
    {"id":"root","component":"Column","children":["role","agree"]},
    {"id":"role","component":"ChoicePicker","variant":"mutuallyExclusive","value":{"path":"/role"},
     "options":[{"label":"Engineer","value":"engineer"},{"label":"Designer","value":"designer"}]},
    {"id":"agree","component":"CheckBox","label":"I agree","value":{"path":"/agree"}}
  ]}}
]`;

// happy-dom + a real click event is required here: renderToStaticMarkup (used
// by the other A2ui*.test.tsx files) never executes an onClick handler, so it
// cannot catch a control whose visible label does nothing when clicked. This
// exact gap let a real bug through: clicking a ChoicePicker/CheckBox option's
// text did nothing, because Radio and Checkbox render as a plain <button>
// with nothing forwarding the click to it, until browser-driven manual
// verification caught it. The fix wraps each option in a <label>, which the
// browser forwards a click anywhere inside it to the <button> automatically
// — that native forwarding is exactly what a static render cannot exercise.
test('clicking a Radio or CheckBox option by its label text toggles it, not only its control', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { A2uiSurfaceView } = await import('./A2uiSurfaceView');

  const parsed = parseA2uiDocument(sampleSource);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.failure.kind}`);
  const [surface] = buildSurfaces(parsed.messages);
  if (!surface) throw new Error('fixture produced no surface');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(
      <I18nProvider><A2uiSurfaceView surface={surface} /></I18nProvider>,
    ));

    const designerRadio = [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((el) => el.getAttribute('aria-label') === 'Designer');
    const designerText = [...container.querySelectorAll('span')].find((el) => el.textContent === 'Designer');
    if (!designerRadio || !designerText) throw new Error('Designer option not found');

    expect(designerRadio.getAttribute('aria-checked')).toBe('false');
    // Click the label text, not the control itself — this is what a person aims for.
    await act(async () => designerText.click());
    expect(designerRadio.getAttribute('aria-checked')).toBe('true');

    const agreeCheckbox = container.querySelector<HTMLElement>('[role="checkbox"][aria-label="I agree"]');
    const agreeText = [...container.querySelectorAll('span')].find((el) => el.textContent === 'I agree');
    if (!agreeCheckbox || !agreeText) throw new Error('CheckBox option not found');

    expect(agreeCheckbox.getAttribute('aria-checked')).toBe('false');
    await act(async () => agreeText.click());
    expect(agreeCheckbox.getAttribute('aria-checked')).toBe('true');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
