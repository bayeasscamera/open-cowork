import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentBlock, ToolResultContent } from '../types';
import { isImageDeliverableTool, shouldAutoExpandToolResult } from '../utils/tool-result-summary';

interface MessageLike {
  content: ContentBlock[];
}

/** Count the images attached to a tool_result, wherever it landed. */
function findResultImages(
  toolUseId: string,
  allBlocks: ContentBlock[] | undefined,
  allMessages: MessageLike[]
): number {
  const inSameBlocks = allBlocks?.find(
    (b) => b.type === 'tool_result' && (b as ToolResultContent).toolUseId === toolUseId
  ) as ToolResultContent | undefined;
  if (inSameBlocks) {
    return inSameBlocks.images?.length ?? 0;
  }
  for (const msg of allMessages) {
    if (!Array.isArray(msg.content)) continue;
    const found = msg.content.find(
      (b) => b.type === 'tool_result' && (b as ToolResultContent).toolUseId === toolUseId
    ) as ToolResultContent | undefined;
    if (found) {
      return found.images?.length ?? 0;
    }
  }
  return 0;
}

/**
 * Expand an image-producing tool result as soon as its image arrives, so the
 * picture is visible immediately instead of hidden behind a click — unless the
 * user collapsed it on purpose (we never fight a manual toggle).
 *
 * The image lands one message AFTER the tool_use, so the initializer alone is
 * not enough: the effect re-checks when the count changes from 0 to N.
 */
export function useAutoExpandToolResult(args: {
  toolUseId: string;
  toolName: string | undefined;
  allBlocks?: ContentBlock[];
  allMessages: MessageLike[];
}): { expanded: boolean; toggle: () => void } {
  const { toolUseId, toolName, allBlocks, allMessages } = args;
  // Only the two image tools need the cross-message scan; skip it for every
  // other tool card so large sessions stay cheap while streaming.
  const imageCount = useMemo(
    () =>
      isImageDeliverableTool(toolName) ? findResultImages(toolUseId, allBlocks, allMessages) : 0,
    [toolUseId, toolName, allBlocks, allMessages]
  );
  const userToggledRef = useRef(false);
  const [expanded, setExpanded] = useState(() =>
    shouldAutoExpandToolResult(toolName, imageCount > 0)
  );

  useEffect(() => {
    if (!userToggledRef.current && shouldAutoExpandToolResult(toolName, imageCount > 0)) {
      setExpanded(true);
    }
  }, [toolName, imageCount]);

  return {
    expanded,
    toggle: () => {
      userToggledRef.current = true;
      setExpanded((prev) => !prev);
    },
  };
}
