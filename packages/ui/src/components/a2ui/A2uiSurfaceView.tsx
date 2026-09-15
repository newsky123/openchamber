import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import type { A2uiDataModel, A2uiJsonValue } from '@/lib/a2ui/protocol';
import { A2UI_ROOT_COMPONENT_ID, readPath, writePath, type A2uiSurfaceState } from '@/lib/a2ui/surface';

import { A2uiNode } from './A2uiNode';
import { A2uiRenderContext } from './a2uiRenderContext';

interface A2uiSurfaceViewProps {
  readonly surface: A2uiSurfaceState;
}

/**
 * What a button hands back when the user submits.
 *
 * `context` is the protocol's resolved action context. `values` is the whole
 * data model, which the protocol does not send but a person reading the card
 * does want: an agent that forgets to declare context would otherwise produce
 * an empty result for a form the user just filled in.
 */
interface A2uiActionResult {
  readonly action: string;
  readonly surfaceId: string;
  readonly context: A2uiDataModel;
  readonly values: A2uiDataModel;
}

const COPY_RESET_MS = 2000;

/**
 * Renders one surface and owns its data model while the card is on screen.
 *
 * The agent's document supplies the initial values; every keystroke after that
 * belongs to the user, so remounting on an unrelated re-render would discard
 * what they typed. State resets only when the surface identity changes.
 */
export const A2uiSurfaceView: React.FC<A2uiSurfaceViewProps> = ({ surface }) => {
  const { t } = useI18n();
  const [dataModel, setDataModel] = React.useState<A2uiDataModel>(surface.dataModel);
  const [result, setResult] = React.useState<A2uiActionResult | null>(null);
  const [copied, setCopied] = React.useState(false);
  const copyResetRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    setDataModel(surface.dataModel);
    setResult(null);
  }, [surface]);

  React.useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
  }, []);

  const writeValue = React.useCallback((path: string, value: A2uiJsonValue) => {
    setDataModel((current) => writePath(current, path, value));
  }, []);

  const runAction = React.useCallback((componentId: string) => {
    const component = surface.components.get(componentId);
    if (!component || component.component !== 'Button') return;

    const context: Record<string, A2uiJsonValue> = {};
    for (const [key, value] of Object.entries(component.action.context ?? {})) {
      const resolved = value.kind === 'binding' ? readPath(dataModel, value.path) : value.value;
      context[key] = resolved ?? null;
    }

    setResult({
      action: component.action.name,
      surfaceId: surface.surfaceId,
      context,
      values: dataModel,
    });
    setCopied(false);
  }, [dataModel, surface]);

  const contextValue = React.useMemo(
    () => ({ components: surface.components, dataModel, writeValue, runAction }),
    [dataModel, runAction, surface.components, writeValue],
  );

  const resultText = React.useMemo(() => (result ? JSON.stringify(result, null, 2) : ''), [result]);

  const handleCopy = React.useCallback(async () => {
    const outcome = await copyTextToClipboard(resultText);
    if (!outcome.ok) return;
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    setCopied(true);
    copyResetRef.current = window.setTimeout(() => {
      copyResetRef.current = null;
      setCopied(false);
    }, COPY_RESET_MS);
  }, [resultText]);

  if (!surface.components.has(A2UI_ROOT_COMPONENT_ID)) {
    return (
      <div data-component="a2ui-surface" className="my-3 rounded-2xl border border-border/80 bg-[var(--surface-elevated)] px-3 py-2">
        <span className="typography-meta text-muted-foreground">{t('chat.a2ui.error.invalid')}</span>
      </div>
    );
  }

  return (
    <div data-component="a2ui-surface" className="my-3 overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]">
      <div className="flex flex-col gap-2 px-3 py-3">
        <A2uiRenderContext.Provider value={contextValue}>
          <A2uiNode componentId={A2UI_ROOT_COMPONENT_ID} />
        </A2uiRenderContext.Provider>
      </div>

      {result ? (
        <div className="border-t border-border/70 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">
              {t('chat.a2ui.result.title', { action: result.action })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => { void handleCopy(); }}
              aria-label={copied ? t('chat.a2ui.result.copied') : t('chat.a2ui.result.copy')}
              title={copied ? t('chat.a2ui.result.copied') : t('chat.a2ui.result.copy')}
            >
              <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
            </Button>
          </div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words typography-code text-muted-foreground">
            {resultText}
          </pre>
        </div>
      ) : null}
    </div>
  );
};
