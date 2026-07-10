import type { ChatLine, ChatPart } from "./components/shared";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "group"; messages: ChatLine[]; startIndex: number; endIndex: number };

export interface RunSegment {
  events?: ChatLine[];
  eventsStart?: number;
  eventsEnd?: number;
  message: ChatLine;
  index: number;
}

export type RenderGroup =
  | ChatGroup
  | { kind: "combined"; events: ChatLine[]; eventsStart: number; eventsEnd: number; message: ChatLine; index: number }
  | { kind: "run"; segments: RunSegment[]; index: number };

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let eventMessages: ChatLine[] = [];
  let eventStartIndex = 0;

  const pushEvent = (message: ChatLine, index: number) => {
    if (!eventMessages.length) eventStartIndex = index;
    eventMessages.push(message);
  };
  const flushEvents = () => {
    if (!eventMessages.length) return;
    groups.push({ kind: "group", messages: eventMessages, startIndex: eventStartIndex, endIndex: eventStartIndex + eventMessages.length - 1 });
    eventMessages = [];
  };

  messages.forEach((message, index) => {
    const readableParts = message.parts.filter((part) => isReadablePart(message, part));
    const technicalParts = message.parts.filter((part) => !isReadablePart(message, part));

    const absoluteIndex = indexOffset + index;
    const metadata = { ...(message.source === undefined ? {} : { source: message.source }), ...(message.meta === undefined ? {} : { meta: message.meta }) };
    if (technicalParts.length) pushEvent({ role: message.role, parts: technicalParts, ...metadata }, absoluteIndex);
    if (readableParts.length) {
      flushEvents();
      const role = readableParts.every((part) => part.type === "skillRead") ? "skill" : message.role;
      groups.push({ kind: "message", message: { role, parts: readableParts, ...metadata }, index: absoluteIndex });
    }
  });
  flushEvents();
  return groups;
}

/**
 * Folds an "events" group into the assistant message that immediately follows it, so the two
 * render as a single bubble (collapsible events on top, visible reply below) instead of two
 * stacked cards. A group only merges into a directly-following assistant message; a trailing
 * events group (e.g. tool results after the final reply) is left standalone.
 */
export function mergeEventGroupsIntoMessages(groups: ChatGroup[]): RenderGroup[] {
  const merged: RenderGroup[] = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const next = groups[index + 1];
    if (group?.kind === "group" && next?.kind === "message" && next.message.role === "assistant" && isMergeableEventGroup(group.messages)) {
      merged.push({ kind: "combined", events: group.messages, eventsStart: group.startIndex, eventsEnd: group.endIndex, message: next.message, index: next.index });
      index += 1;
      continue;
    }
    if (group !== undefined) merged.push(group);
  }
  return merged;
}

function isMergeableEventGroup(messages: ChatLine[]): boolean {
  return !messages.some((message) => message.source === "compaction" || message.source === "branch_summary");
}

type AssistantTurn = Extract<RenderGroup, { kind: "message" | "combined" }>;

function isAssistantTurn(group: RenderGroup): group is AssistantTurn {
  return group.kind === "combined" || (group.kind === "message" && group.message.role === "assistant");
}

function toRunSegment(turn: AssistantTurn): RunSegment {
  if (turn.kind === "combined") return { events: turn.events, eventsStart: turn.eventsStart, eventsEnd: turn.eventsEnd, message: turn.message, index: turn.index };
  return { message: turn.message, index: turn.index };
}

function segmentToTurn(segment: RunSegment): AssistantTurn {
  if (segment.events === undefined || segment.eventsStart === undefined || segment.eventsEnd === undefined) return { kind: "message", message: segment.message, index: segment.index };
  return { kind: "combined", events: segment.events, eventsStart: segment.eventsStart, eventsEnd: segment.eventsEnd, message: segment.message, index: segment.index };
}

/**
 * Folds a run of back-to-back assistant turns (each already event+reply, or reply-only) into a
 * single bubble, so a multi-step assistant response reads as one continuous card with a dashed
 * divider between steps instead of a stack of near-identical "ASSISTANT" cards.
 */
export function mergeConsecutiveAssistantTurns(groups: RenderGroup[]): RenderGroup[] {
  const merged: RenderGroup[] = [];
  let run: RunSegment[] = [];
  const flushRun = () => {
    const [first, ...rest] = run;
    if (first === undefined) return;
    merged.push(rest.length === 0 ? segmentToTurn(first) : { kind: "run", segments: run, index: first.index });
    run = [];
  };

  for (const group of groups) {
    if (isAssistantTurn(group)) {
      run.push(toRunSegment(group));
      continue;
    }
    flushRun();
    merged.push(group);
  }
  flushRun();
  return merged;
}

export function summarizeChatGroup(messages: ChatLine[]): string {
  if (messages.every((message) => message.source === "compaction")) return `${String(messages.length)} history compaction ${messages.length === 1 ? "summary" : "summaries"}`;
  if (messages.every((message) => message.source === "branch_summary")) return `${String(messages.length)} branch ${messages.length === 1 ? "summary" : "summaries"}`;
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const details = Object.entries(counts).map(([role, count]) => `${String(count)} ${role}`).join(" · ");
  return `${String(messages.length)} ${messages.length === 1 ? "event" : "events"}${details !== "" ? ` · ${details}` : ""}`;
}

function isReadablePart(message: ChatLine, part: ChatPart): boolean {
  if (message.source === "compaction" || message.source === "branch_summary") return false;
  if (part.type === "skillInvocation" || part.type === "skillRead") return true;
  return part.type === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "bash");
}
