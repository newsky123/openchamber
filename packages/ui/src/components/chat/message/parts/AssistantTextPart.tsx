import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase, ToolPopupContent } from '../types';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { GeneratedJsonResultCard } from './GeneratedJsonResultCard';
import { parseGeneratedJsonResult } from './generatedJsonResult';
import { A2uiBlock } from '@/components/a2ui/A2uiBlock';
import { hasA2uiFence, splitA2uiSegments } from '@/lib/a2ui/fence';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    chatRenderMode?: 'sorted' | 'live';
    onShowPopup?: (content: ToolPopupContent) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    chatRenderMode = 'live',
    onShowPopup,
}) => {
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const isStreaming = chatRenderMode === 'live' && (isStreamingPhase || isCooldownPhase);

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    const generatedResult = !isStreaming && isFinalized ? parseGeneratedJsonResult(displayTextContent) : null;
    if (generatedResult) {
        return (
            <div
                className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
                key={part.id || `${messageId}-text`}
            >
                <GeneratedJsonResultCard result={generatedResult} />
            </div>
        );
    }

    // An A2UI document renders as an interactive card instead of a JSON code
    // block. The scan is skipped while the message streams: the closing fence
    // has not arrived yet, so a half-written document would flash a broken
    // card on every delta.
    const a2uiSegments = !isStreaming && hasA2uiFence(displayTextContent)
        ? splitA2uiSegments(displayTextContent)
        : null;

    if (a2uiSegments?.some((segment) => segment.kind === 'a2ui')) {
        return (
            <div
                className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
                key={part.id || `${messageId}-text`}
            >
                {a2uiSegments.map((segment, index) => (segment.kind === 'a2ui' ? (
                    <A2uiBlock key={`a2ui-${index}`} source={segment.source} />
                ) : (
                    // `part` is deliberately omitted: the detached-DOM cache keys
                    // on message id, part id and content length, so two segments
                    // of one part could otherwise restore each other's DOM.
                    <MarkdownRenderer
                        key={`markdown-${index}`}
                        content={segment.text}
                        messageId={messageId}
                        isAnimated={false}
                        isStreaming={false}
                        disableStreamAnimation={chatRenderMode === 'sorted'}
                        variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                        enableFileReferences={isFinalized}
                        onShowPopup={onShowPopup}
                    />
                )))}
            </div>
        );
    }

    return (
        <div
            className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
            key={part.id || `${messageId}-text`}
        >
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                disableStreamAnimation={chatRenderMode === 'sorted'}
                variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                enableFileReferences={isFinalized}
                onShowPopup={onShowPopup}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart);
