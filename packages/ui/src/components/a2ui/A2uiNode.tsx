import React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { bindingPath, resolveBoolean, resolveString, resolveStringList } from '@/lib/a2ui/surface';
import { cn } from '@/lib/utils';

import { useA2uiRenderContext } from './a2uiRenderContext';

/**
 * A component tree is a map of ids, so a document can reference itself in a
 * cycle. Depth is the cheapest guard that also bounds how much work one card
 * can ask of the chat render path.
 */
const MAX_DEPTH = 24;

const ALIGN_CLASS = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
} as const;

const JUSTIFY_CLASS = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  spaceBetween: 'justify-between',
  spaceAround: 'justify-around',
  spaceEvenly: 'justify-evenly',
  stretch: 'justify-stretch',
} as const;

const TEXT_CLASS = {
  h1: 'text-lg font-semibold text-foreground',
  h2: 'text-base font-semibold text-foreground',
  h3: 'text-sm font-semibold text-foreground',
  h4: 'text-sm font-medium text-foreground',
  h5: 'text-xs font-medium text-foreground',
  body: 'typography-markdown text-foreground',
  caption: 'typography-meta text-muted-foreground',
} as const;

interface A2uiNodeProps {
  readonly componentId: string;
  readonly depth?: number;
}

const FieldLabel: React.FC<{ readonly text: string }> = ({ text }) => {
  if (!text) return null;
  return <span className="typography-meta text-muted-foreground">{text}</span>;
};

export const A2uiNode: React.FC<A2uiNodeProps> = ({ componentId, depth = 0 }) => {
  const { components, dataModel, writeValue, runAction } = useA2uiRenderContext();
  const { t } = useI18n();

  const component = components.get(componentId);
  if (!component || depth > MAX_DEPTH) return null;

  if (component.component === 'Unsupported') {
    return (
      <span className="typography-meta text-muted-foreground">
        {t('chat.a2ui.unsupportedComponent', { component: component.name })}
      </span>
    );
  }

  if (component.component === 'Text') {
    return <div className={TEXT_CLASS[component.variant ?? 'body']}>{resolveString(component.text, dataModel)}</div>;
  }

  if (component.component === 'Divider') {
    return component.axis === 'vertical'
      ? <div className="self-stretch w-px bg-border/70" />
      : <div className="h-px w-full bg-border/70" />;
  }

  if (component.component === 'Row' || component.component === 'Column') {
    const isRow = component.component === 'Row';
    return (
      <div
        className={cn(
          'flex gap-2',
          isRow ? 'flex-row flex-wrap' : 'flex-col',
          ALIGN_CLASS[component.align ?? (isRow ? 'center' : 'stretch')],
          component.justify ? JUSTIFY_CLASS[component.justify] : undefined,
        )}
      >
        {component.children.map((childId) => (
          <A2uiNode key={childId} componentId={childId} depth={depth + 1} />
        ))}
      </div>
    );
  }

  if (component.component === 'Card') {
    return (
      <div className="rounded-xl border border-border/80 bg-[var(--surface-elevated)] p-3">
        <A2uiNode componentId={component.child} depth={depth + 1} />
      </div>
    );
  }

  if (component.component === 'Button') {
    return (
      <Button
        type="button"
        size="sm"
        variant={component.primary === true ? 'default' : 'outline'}
        onClick={() => runAction(component.id)}
      >
        <A2uiNode componentId={component.child} depth={depth + 1} />
      </Button>
    );
  }

  if (component.component === 'TextField') {
    const path = bindingPath(component.value);
    const value = resolveString(component.value, dataModel);
    const label = resolveString(component.label, dataModel);

    return (
      <label className="flex flex-col gap-1">
        <FieldLabel text={label} />
        {component.variant === 'longText' ? (
          <Textarea
            value={value}
            disabled={path === null}
            rows={3}
            onChange={(event) => { if (path) writeValue(path, event.target.value); }}
          />
        ) : (
          <Input
            type={component.variant === 'number' ? 'number' : component.variant === 'obscured' ? 'password' : 'text'}
            value={value}
            disabled={path === null}
            onChange={(event) => { if (path) writeValue(path, event.target.value); }}
          />
        )}
      </label>
    );
  }

  if (component.component === 'CheckBox') {
    const path = bindingPath(component.value);
    const checked = resolveBoolean(component.value, dataModel);
    const label = resolveString(component.label, dataModel);

    return (
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checked}
          disabled={path === null}
          ariaLabel={label}
          onChange={(next) => { if (path) writeValue(path, next); }}
        />
        <span className="typography-markdown text-foreground">{label}</span>
      </div>
    );
  }

  const path = bindingPath(component.value);
  const selected = resolveStringList(component.value, dataModel);
  const multiple = component.variant === 'multipleSelection';
  const label = resolveString(component.label, dataModel);

  const toggle = (optionValue: string) => {
    if (!path) return;
    if (!multiple) {
      writeValue(path, [optionValue]);
      return;
    }
    const next = selected.includes(optionValue)
      ? selected.filter((entry) => entry !== optionValue)
      : [...selected, optionValue];
    writeValue(path, next);
  };

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel text={label} />
      <div className="flex flex-col gap-1.5">
        {component.options.map((option) => {
          const optionLabel = resolveString(option.label, dataModel);
          const checked = selected.includes(option.value);
          return (
            <div key={option.value} className="flex items-center gap-2">
              {multiple ? (
                <Checkbox
                  checked={checked}
                  disabled={path === null}
                  ariaLabel={optionLabel}
                  onChange={() => toggle(option.value)}
                />
              ) : (
                <Radio
                  checked={checked}
                  disabled={path === null}
                  ariaLabel={optionLabel}
                  onChange={() => toggle(option.value)}
                />
              )}
              <span className="typography-markdown text-foreground">{optionLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
