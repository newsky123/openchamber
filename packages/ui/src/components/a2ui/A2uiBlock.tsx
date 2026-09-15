import React from 'react';

import { useI18n } from '@/lib/i18n';
import { parseA2uiDocument } from '@/lib/a2ui/protocol';
import { buildSurfaces } from '@/lib/a2ui/surface';

import { A2uiSurfaceView } from './A2uiSurfaceView';

interface A2uiBlockProps {
  /** The raw contents of one ```a2ui fence. */
  readonly source: string;
}

/**
 * One A2UI document inside an assistant message.
 *
 * A document that cannot be rendered says so in one line rather than falling
 * back to the raw JSON: the JSON is the agent's wire format, not something a
 * reader of the conversation asked to see.
 */
export const A2uiBlock: React.FC<A2uiBlockProps> = ({ source }) => {
  const { t } = useI18n();
  const parsed = React.useMemo(() => parseA2uiDocument(source), [source]);
  const surfaces = React.useMemo(
    () => (parsed.ok ? buildSurfaces(parsed.messages) : []),
    [parsed],
  );

  if (!parsed.ok) {
    const failure = parsed.failure;
    let message = t('chat.a2ui.error.invalid');
    if (failure.kind === 'unsupported-version') {
      message = t('chat.a2ui.error.unsupportedVersion', { version: failure.version });
    } else if (failure.kind === 'too-large') {
      message = t('chat.a2ui.error.tooLarge');
    }

    return (
      <div data-component="a2ui-error" className="my-3 rounded-2xl border border-border/80 bg-[var(--surface-elevated)] px-3 py-2">
        <span className="typography-meta text-muted-foreground">{message}</span>
      </div>
    );
  }

  return (
    <>
      {surfaces.map((surface) => (
        <A2uiSurfaceView key={surface.surfaceId} surface={surface} />
      ))}
    </>
  );
};
