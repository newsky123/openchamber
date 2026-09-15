import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { parseA2uiDocument } from '@/lib/a2ui/protocol';
import { buildSurfaces } from '@/lib/a2ui/surface';

import { A2uiBlock } from './A2uiBlock';
import { A2uiSurfaceView } from './A2uiSurfaceView';

const sampleSource = readFileSync(new URL('./fixtures/feedback-form.a2ui.json', import.meta.url), 'utf8');

const renderSample = () => {
  const parsed = parseA2uiDocument(sampleSource);
  if (!parsed.ok) throw new Error(`the sample document did not parse: ${parsed.failure.kind}`);
  const [surface] = buildSurfaces(parsed.messages);
  if (!surface) throw new Error('the sample document produced no surface');
  return renderToStaticMarkup(
    <I18nProvider>
      <A2uiSurfaceView surface={surface} />
    </I18nProvider>,
  );
};

describe('the sample A2UI document', () => {
  test('renders its text, fields and choices', () => {
    const markup = renderSample();
    expect(markup).toContain('Session feedback');
    expect(markup).toContain('Your name');
    expect(markup).toContain('Engineer');
    expect(markup).toContain('Email me the summary');
    expect(markup).toContain('Submit');
  });

  test('renders a bound long-text field as a textarea and a short one as an input', () => {
    const markup = renderSample();
    expect(markup).toContain('<textarea');
    expect(markup).toContain('<input');
  });

  test('leaves every bound control enabled, because each one has somewhere to write', () => {
    expect(renderSample()).not.toContain('disabled=""');
  });
});

describe('A2uiBlock', () => {
  const render = (source: string) => renderToStaticMarkup(
    <I18nProvider>
      <A2uiBlock source={source} />
    </I18nProvider>,
  );

  test('renders the sample document as a surface', () => {
    expect(render(sampleSource)).toContain('data-component="a2ui-surface"');
  });

  test('says which version it cannot render instead of showing the payload', () => {
    const markup = render('{"version":"v0.9","createSurface":{"surfaceId":"s","catalogId":"basic"}}');
    expect(markup).toContain('data-component="a2ui-error"');
    expect(markup).toContain('v0.9');
    expect(markup).not.toContain('catalogId');
  });

  test('never falls back to the raw payload for a malformed document', () => {
    const markup = render('{"version":"v1.0","createSurface":');
    expect(markup).toContain('data-component="a2ui-error"');
    expect(markup).not.toContain('createSurface');
  });

  test('renders a document whose root is missing as a notice rather than an orphan component', () => {
    const markup = render('{"version":"v1.0","updateComponents":{"surfaceId":"s","components":[{"id":"stray","component":"Text","text":"orphaned-copy"}]}}');
    expect(markup).not.toContain('orphaned-copy');
    expect(markup).toContain('could not be displayed');
  });

  test('shows a placeholder for a component it does not implement', () => {
    const markup = render(JSON.stringify({
      version: 'v1.0',
      createSurface: {
        surfaceId: 's',
        components: [
          { id: 'root', component: 'Column', children: ['clip'] },
          { id: 'clip', component: 'Video', url: 'https://example.com/a.mp4' },
        ],
      },
    }));
    expect(markup).toContain('Video');
    expect(markup).not.toContain('example.com');
  });
});
