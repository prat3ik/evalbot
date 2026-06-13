"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { SaveToDatasetDialog } from "@/components/SaveToDatasetDialog";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { ScoreTile } from "@/components/ui/ScoreTile";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/relativeTime";
import {
  ApiError,
  api,
  chatbotEndpointsApi,
  conversationsApi,
  type AiProvider,
  type ChatbotEndpoint,
  type ChatbotEndpointTestResult,
  type Conversation,
  type ConversationEvaluationResult,
  type ConversationListItem,
  type EvaluationMethod,
  type FindingSeverity,
  type GuidelineFindingOut,
  type Message,
  type MessageInput,
  type Project,
  type Role,
  type TurnEvaluation,
} from "@/lib/api";

// Tool role + tool_calls retained server-side for re-enable; UI exposes
// only user + assistant.
const ROLE_OPTIONS: Role[] = ["user", "assistant"];

const PROVIDER_OPTIONS: { label: string; value: AiProvider }[] = [
  { label: "Claude", value: "anthropic" },
  { label: "Gemini", value: "gemini" },
  { label: "OpenAI", value: "openai" },
  { label: "Ollama", value: "ollama" },
];

const SEVERITY_VARIANT: Record<FindingSeverity, BadgeVariant> = {
  minor: "warn",
  major: "warn",
  critical: "danger",
};

function normaliseSeverity(s: FindingSeverity | string | null): FindingSeverity {
  if (s === "minor" || s === "major" || s === "critical") return s;
  return "minor";
}

export function MultiTurnTab({
  project,
  initialConvId: _initialConvId,
}: {
  project: Project;
  initialConvId?: string;
}) {
  const projectId = project.id;
  const qc = useQueryClient();
  // Each visit to the Multi-Turn tab is an ephemeral draft. A fresh
  // Conversation is created on mount so the existing message-CRUD endpoints
  // still work; once the user clicks "New chat" we discard it and create
  // another. Persistent state lives in datasets (multi-turn rows), not here.
  const [draftConvId, setDraftConvId] = React.useState<string>("");
  const draftCreatingRef = React.useRef(false);
  const method: EvaluationMethod = "ai";
  const [provider, setProvider] = React.useState<AiProvider>("anthropic");

  const ensureDraft = React.useCallback(async () => {
    if (draftConvId || draftCreatingRef.current) return;
    draftCreatingRef.current = true;
    try {
      const created = await conversationsApi.create(projectId, {
        title: "Untitled chat",
      });
      setDraftConvId(created.id);
    } finally {
      draftCreatingRef.current = false;
    }
  }, [draftConvId, projectId]);

  // Don't auto-create on mount — wait until the user actually starts a chat.
  // Empty drafts otherwise pile up in Project Activity on every tab visit.

  const conversationQ = useQuery({
    queryKey: ["conversation", draftConvId],
    queryFn: () => conversationsApi.get(draftConvId),
    enabled: Boolean(draftConvId),
  });

  const [evalResult, setEvalResult] = React.useState<ConversationEvaluationResult | null>(null);

  const evalMut = useMutation<
    ConversationEvaluationResult,
    Error,
    { id: string; method: EvaluationMethod; ai_provider: string | null }
  >({
    mutationFn: ({ id, method: m, ai_provider }) =>
      conversationsApi.evaluate(id, { method: m, ai_provider }),
    onSuccess: (data) => setEvalResult(data),
  });

  const invalidateConv = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["conversation", draftConvId] });
  }, [qc, draftConvId]);

  const startNewChat = async () => {
    // Discard the current draft on the server (best-effort) and spin up a
    // fresh one. Done as a single user action so the editor only ever holds
    // a draft when the user actively wants one.
    const old = draftConvId;
    setDraftConvId("");
    setEvalResult(null);
    evalMut.reset();
    if (old) {
      try {
        await conversationsApi.delete(old);
      } catch {
        // ignore — orphan drafts won't show up in Activity anyway.
      }
    }
    await ensureDraft();
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4">
      <Card className="p-5">
        {!draftConvId ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border bg-surface-sunken/30 px-6 py-12 text-center">
            <h3 className="font-serif text-[18px] leading-[26px] text-text">
              Start a multi-turn chat
            </h3>
            <p className="max-w-[40ch] font-sans text-[13px] leading-[18px] text-text-muted">
              Build a conversation turn-by-turn, fetch the bot's reply from a
              configured endpoint, then run an evaluation or save it to a
              dataset.
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={ensureDraft}
            >
              <Plus className="h-4 w-4" /> New chat
            </Button>
          </div>
        ) : conversationQ.isLoading || !conversationQ.data ? (
          <div className="font-sans text-[14px] text-text-muted">Loading…</div>
        ) : (
          <ConversationEditor
            projectId={projectId}
            conversation={conversationQ.data}
            provider={provider}
            onProviderChange={setProvider}
            onRunEvaluation={() => {
              if (!draftConvId) return;
              evalMut.mutate({
                id: draftConvId,
                method,
                ai_provider: provider,
              });
            }}
            onNewChat={startNewChat}
            evaluating={evalMut.isPending}
            invalidateConv={invalidateConv}
          />
        )}
      </Card>

      <Card className="p-5">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Run Results</CardTitle>
          </div>
        </CardHeader>
        {evalMut.isPending ? (
          <ResultsSkeleton />
        ) : evalMut.isError ? (
          <ErrorPanel error={evalMut.error} />
        ) : evalResult ? (
          <ResultsPanel result={evalResult} projectId={projectId} />
        ) : (
          <ResultsEmpty />
        )}
      </Card>
    </div>
  );
}

function ConversationList({
  conversations,
  loading,
  selectedId,
  onSelect,
  onDelete,
}: {
  conversations: ConversationListItem[];
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  if (loading) {
    return <div className="font-sans text-[13px] text-text-muted">Loading…</div>;
  }
  if (conversations.length === 0) {
    return (
      <div className="py-4 font-serif text-[15px] leading-[22px] text-text-muted">
        No conversations yet. Create one to start building chat evaluations.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {conversations.map((c) => (
        <li key={c.id}>
          <ConversationRow
            item={c}
            active={c.id === selectedId}
            onSelect={() => onSelect(c.id)}
            onDelete={() => onDelete(c.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function ConversationRow({
  item,
  active,
  onSelect,
  onDelete,
}: {
  item: ConversationListItem;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <div
      className={cn(
        "relative cursor-pointer rounded-md border transition-colors duration-fast ease-ev",
        active
          ? "border-accent bg-accent-soft"
          : "border-border bg-surface-raised hover:bg-surface-sunken",
      )}
    >
      <button type="button" onClick={onSelect} className="w-full px-3 py-2 pr-9 text-left">
        <span className="block min-w-0 truncate font-sans text-[15px] font-medium leading-[22px] text-text">
          {item.title || "Untitled"}
        </span>
        <div className="mt-0.5 flex items-center gap-2 font-sans text-[11px] leading-[14px] text-text-muted">
          <span>
            {item.turn_count} turn{item.turn_count === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <span>{relativeTime(item.created_at)}</span>
        </div>
      </button>
      <button
        type="button"
        aria-label="Conversation actions"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menuOpen && (
        <div
          className="absolute right-1.5 top-9 z-10 rounded-md border border-border bg-surface-raised shadow-elev-2"
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            type="button"
            onClick={async (e) => {
              e.stopPropagation();
              setMenuOpen(false);
              await onDelete();
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 font-sans text-[13px] text-danger hover:bg-danger-soft"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function ConversationEditor({
  projectId,
  conversation,
  provider,
  onProviderChange,
  onRunEvaluation,
  onNewChat,
  evaluating,
  invalidateConv,
}: {
  projectId: string;
  conversation: Conversation;
  provider: AiProvider;
  onProviderChange: (p: AiProvider) => void;
  onRunEvaluation: () => void;
  onNewChat?: () => void;
  evaluating: boolean;
  invalidateConv: () => void;
}) {
  const [title, setTitle] = React.useState(conversation.title);
  const [editingTitle, setEditingTitle] = React.useState(false);

  React.useEffect(() => {
    setTitle(conversation.title);
  }, [conversation.id, conversation.title]);

  const titleMut = useMutation({
    mutationFn: (next: string) => conversationsApi.updateTitle(conversation.id, next),
    onSuccess: invalidateConv,
  });

  const appendMut = useMutation({
    mutationFn: (msg: MessageInput) => conversationsApi.appendMessage(conversation.id, msg),
    onSuccess: invalidateConv,
  });

  const insertAtMut = useMutation({
    mutationFn: async (input: { msg: MessageInput; position: number }) => {
      const created = await conversationsApi.appendMessage(conversation.id, input.msg);
      if (created.position !== input.position) {
        await conversationsApi.reorderMessage(conversation.id, created.id, input.position);
      }
      return created;
    },
    onSuccess: invalidateConv,
  });

  const deleteMsgMut = useMutation({
    mutationFn: (messageId: string) => conversationsApi.deleteMessage(conversation.id, messageId),
    onSuccess: invalidateConv,
  });

  const reorderMut = useMutation({
    mutationFn: ({ messageId, position }: { messageId: string; position: number }) =>
      conversationsApi.reorderMessage(conversation.id, messageId, position),
    onSuccess: invalidateConv,
  });

  const messages = conversation.messages;
  const hasAssistant = messages.some((m) => m.role === "assistant");

  const [addRole, setAddRole] = React.useState<Role>("user");

  // Configured ChatbotEndpoints for this project. When an endpoint is
  // selected, each assistant message gets a "Fetch from endpoint" action
  // that posts the prior user turn to the endpoint and pastes the response.
  const endpointsQ = useQuery({
    queryKey: ["chatbot-endpoints", projectId],
    queryFn: () => chatbotEndpointsApi.list(projectId),
  });
  const endpoints: ChatbotEndpoint[] = endpointsQ.data ?? [];
  const [selectedEndpointId, setSelectedEndpointId] = React.useState<string>("");
  React.useEffect(() => {
    if (!endpoints.length || selectedEndpointId) return;
    const def = endpoints.find((e) => e.is_default) ?? endpoints[0];
    if (def) setSelectedEndpointId(def.id);
  }, [endpoints, selectedEndpointId]);

  function commitTitle() {
    setEditingTitle(false);
    const next = title.trim();
    if (next && next !== conversation.title) {
      titleMut.mutate(next);
    } else {
      setTitle(conversation.title);
    }
  }

  const turnCount = messages.filter((m) => m.role === "assistant").length;
  const visibleCount = messages.filter((m) => m.role !== "system").length;

  const lastChatRole = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const r = messages[i]!.role;
      if (r === "user" || r === "assistant") return r;
    }
    return null;
  })();
  const orderedAddRoles: Role[] =
    lastChatRole === "user" ? ["assistant", "user"] : ["user", "assistant"];

  // Save the current chat (turns) as a multi-turn dataset row.
  const [saveOpen, setSaveOpen] = React.useState(false);
  const chatTurns = React.useMemo(
    () =>
      messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    [messages],
  );
  const lastUserContent = React.useMemo(() => {
    for (let i = chatTurns.length - 1; i >= 0; i--) {
      if (chatTurns[i]!.role === "user") return chatTurns[i]!.content;
    }
    return "";
  }, [chatTurns]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex flex-col gap-1">
          {editingTitle ? (
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setTitle(conversation.title);
                  setEditingTitle(false);
                }
              }}
              className="max-w-[480px]"
            />
          ) : (
            <h1>
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className="group -mx-1 inline-flex max-w-full items-center gap-2 rounded-md px-1 font-serif text-[22px] font-medium leading-[30px] text-text hover:bg-surface-sunken"
              >
                <span className="truncate">{conversation.title || "Untitled chat"}</span>
                <Pencil className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity duration-fast ease-ev group-hover:opacity-60" />
              </button>
            </h1>
          )}
          <div className="flex items-center gap-2 font-sans text-[12px] leading-[16px] text-text-muted">
            <span>
              {visibleCount} message{visibleCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>
              {turnCount} assistant turn{turnCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={chatTurns.length === 0}
            onClick={() => setSaveOpen(true)}
          >
            <BookmarkPlus className="h-4 w-4" />
            Save to dataset
          </Button>
          {onNewChat && (
            <Button type="button" variant="ghost" size="sm" onClick={onNewChat}>
              <Plus className="h-4 w-4" />
              New chat
            </Button>
          )}
        </div>
      </div>

      <SaveToDatasetDialog
        projectId={projectId}
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        defaultValues={{
          question: lastUserContent,
          expected_response: "",
          chatbot_response: "",
          tags: ["multi-turn"],
          turns: chatTurns,
        }}
      />

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="md"
            disabled={!hasAssistant || evaluating}
            onClick={onRunEvaluation}
          >
            <Play className="h-4 w-4" />
            {evaluating ? "Running…" : "Run Evaluation"}
          </Button>

          {endpoints.length > 0 && (
            <div className="flex items-center gap-2">
              <label
                htmlFor="multiturn-chatbot-endpoint"
                className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted"
                title="Configured chatbot endpoint to fetch assistant replies from."
              >
                Chatbot
              </label>
              <Select
                id="multiturn-chatbot-endpoint"
                selectSize="sm"
                value={selectedEndpointId}
                onChange={(e) => setSelectedEndpointId(e.target.value)}
                className="w-[160px]"
              >
                {endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label
              htmlFor="multiturn-judge-provider"
              className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted"
              title="LLM that grades the chatbot's response."
            >
              Judge
            </label>
            <Select
              id="multiturn-judge-provider"
              selectSize="sm"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as AiProvider)}
              className="w-[140px]"
              title="LLM that grades the chatbot's response."
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border bg-surface-sunken/40 px-6 py-10 text-center">
          <p className="max-w-[36ch] font-serif text-[16px] leading-[24px] text-text-muted">
            Start by adding a user message
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => appendMut.mutate({ role: "user", content: "" })}
          >
            <Plus className="h-4 w-4" />
            Add user message
          </Button>
        </div>
      ) : (
        (() => {
          const chatMsgs = messages.filter((m) => m.role !== "system");
          // Resolve the most recent user message above each row so the
          // "fetch from endpoint" action knows what question to send.
          const priorUserByIdx: string[] = [];
          let lastUser = "";
          for (const m of chatMsgs) {
            if (m.role === "user") lastUser = m.content || "";
            priorUserByIdx.push(lastUser);
          }
          return (
            <ul className="flex flex-col gap-4">
              {chatMsgs.map((m, i) => (
                <li key={m.id}>
                  <MessageRow
                    message={m}
                    index={i}
                    total={chatMsgs.length}
                    conversationId={conversation.id}
                    projectId={projectId}
                    provider={provider}
                    selectedEndpointId={selectedEndpointId || null}
                    selectedEndpointName={
                      endpoints.find((ep) => ep.id === selectedEndpointId)?.name ?? null
                    }
                    priorUserContent={priorUserByIdx[i]}
                    onAfterMutate={invalidateConv}
                    onDelete={() => deleteMsgMut.mutate(m.id)}
                    onMoveUp={() =>
                      reorderMut.mutate({
                        messageId: m.id,
                        position: Math.max(0, m.position - 1),
                      })
                    }
                    onMoveDown={() =>
                      reorderMut.mutate({
                        messageId: m.id,
                        position: m.position + 1,
                      })
                    }
                    onInsertBelow={(role) =>
                      insertAtMut.mutate({
                        msg: { role, content: "" },
                        position: m.position + 1,
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          );
        })()
      )}

      {messages.length > 0 && (
        <div className="sticky bottom-0 -mx-5 border-t border-border bg-surface px-5 pt-3">
          <div className="flex items-center justify-center gap-2">
            <span className="font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
              Add
            </span>
            {orderedAddRoles.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  setAddRole(r);
                  appendMut.mutate({ role: r, content: "" });
                }}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md border px-2 font-sans text-[12px]",
                  "transition-colors duration-fast ease-ev",
                  r === addRole
                    ? "border-accent/40 bg-accent-soft text-accent-pressed"
                    : "border-border bg-surface-raised text-text hover:bg-surface-sunken",
                )}
              >
                <Plus className="h-3 w-3" />
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  index,
  total,
  conversationId,
  projectId,
  provider,
  selectedEndpointId,
  selectedEndpointName,
  priorUserContent,
  onAfterMutate,
  onDelete,
  onMoveUp,
  onMoveDown,
  onInsertBelow,
}: {
  message: Message;
  index: number;
  total: number;
  conversationId: string;
  projectId: string;
  provider: AiProvider;
  selectedEndpointId: string | null;
  selectedEndpointName: string | null;
  priorUserContent: string;
  onAfterMutate: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onInsertBelow: (role: Role) => void;
}) {
  const [content, setContent] = React.useState(message.content);
  const [insertOpen, setInsertOpen] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [expected, setExpected] = React.useState<string>(
    message.expected_response ?? "",
  );
  const [expectedOpen, setExpectedOpen] = React.useState<boolean>(
    Boolean(message.expected_response),
  );

  React.useEffect(() => {
    setContent(message.content);
    setExpected(message.expected_response ?? "");
    setExpectedOpen(Boolean(message.expected_response));
  }, [message.id, message.content, message.expected_response]);

  const updateMut = useMutation({
    mutationFn: (msg: MessageInput) =>
      conversationsApi.updateMessage(conversationId, message.id, msg),
    onSuccess: onAfterMutate,
  });

  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [expectedGenError, setExpectedGenError] = React.useState<string | null>(
    null,
  );
  const generateExpectedMut = useMutation({
    mutationFn: async () => {
      const q = (priorUserContent ?? "").trim();
      if (!q) {
        throw new Error("Add a user message above this turn first.");
      }
      const r = await api.reference.generate(projectId, {
        question: q,
        provider,
        forceRegenerate: true,
      });
      return r.answer || "";
    },
    onSuccess: (answer) => {
      setExpectedGenError(null);
      setExpected(answer);
      setExpectedOpen(true);
    },
    onError: (e: Error) => {
      // Surface the server's `detail` string when present so the user sees
      // the real reason (missing provider creds, no docs ingested, etc.)
      // rather than just "HTTP 400".
      if (e instanceof ApiError) {
        const body = e.body as { detail?: unknown } | null;
        const detail = body?.detail;
        setExpectedGenError(
          typeof detail === "string" ? detail : e.message,
        );
      } else {
        setExpectedGenError(e.message);
      }
    },
  });
  const fetchMut = useMutation<ChatbotEndpointTestResult, Error, void>({
    mutationFn: async () => {
      if (!selectedEndpointId) throw new Error("Pick a chatbot endpoint first.");
      const q = (priorUserContent ?? "").trim();
      if (!q) throw new Error("Add a user message above this turn first.");
      return chatbotEndpointsApi.test(selectedEndpointId, { question: q });
    },
    onSuccess: (r) => {
      setFetchError(r.error ?? null);
      const text = (r.response_text ?? "").trim();
      if (text) {
        setContent(text);
        // Persist immediately, don't wait for the 600ms debounce.
        updateMut.mutate({
          role: message.role,
          content: text,
          tool_calls: null,
          tool_call_id: null,
        });
      }
    },
    onError: (e) => setFetchError(e.message),
  });

  const buildPayload = React.useCallback(
    (): MessageInput => ({
      role: message.role,
      content,
      tool_calls: null,
      tool_call_id: null,
      expected_response: expected.trim() || null,
    }),
    [content, expected, message.role],
  );

  React.useEffect(() => {
    if (content === message.content) return;
    const t = window.setTimeout(() => {
      updateMut.mutate(buildPayload());
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  React.useEffect(() => {
    if ((expected || "") === (message.expected_response || "")) return;
    const t = window.setTimeout(() => {
      updateMut.mutate(buildPayload());
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expected]);

  const saveOnBlur = () => {
    updateMut.mutate(buildPayload());
  };

  const role = message.role;
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const isTool = role === "tool";
  const [focused, setFocused] = React.useState(false);

  const isEmpty = content.trim() === "";
  // Per-role bubble container styling — borders carry the structure, no shadows.
  const bubbleBg = isUser
    ? "bg-accent-soft border border-accent/30"
    : isAssistant
      ? "bg-surface-raised border border-border"
      : "bg-warn-soft border border-warn/30"; // tool (legacy data only)
  const dashed = isEmpty && !focused ? "border-dashed" : "";

  const rowAlign = isUser ? "items-end" : "items-start";
  // Width AND height are content-driven (via the textarea's measurement
  // mirror). Capped at 92% of the column so the chat shape still reads.
  const bubbleMaxW = "w-fit max-w-[92%] min-w-[140px]";

  const focusTextarea = () => {
    textareaRef.current?.focus();
  };

  return (
    <div className={cn("group/row flex w-full flex-col", rowAlign)}>
      <div className={cn("flex w-full flex-col gap-1", isUser ? "items-end" : "items-start")}>
        {/* Bubble */}
        <div className={cn("flex flex-col gap-2", bubbleMaxW)}>
          <div
            className={cn(
              "group/bubble relative min-w-0 cursor-text rounded-2xl px-3.5 py-2.5",
              isUser ? "rounded-br-md" : isAssistant ? "rounded-bl-md" : "",
              bubbleBg,
              dashed,
            )}
            onClick={focusTextarea}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          >
            <AutoResizeTextarea
              ref={textareaRef}
              value={content}
              onChange={setContent}
              onBlur={() => {
                setFocused(false);
                saveOnBlur();
              }}
              onFocus={() => setFocused(true)}
              placeholder={
                isAssistant
                  ? "Write the assistant response — this row needs content"
                  : isUser
                    ? "Write the user message…"
                    : "tool message (legacy)"
              }
              variant={isTool ? "tool" : "bubble"}
            />
          </div>
          {fetchError && (
            <p className="px-1 font-sans text-[12px] text-danger" role="alert">
              {fetchError}
            </p>
          )}

          {isAssistant && selectedEndpointId && (
            <button
              type="button"
              onClick={() => {
                setFetchError(null);
                fetchMut.mutate();
              }}
              disabled={fetchMut.isPending || !priorUserContent.trim()}
              className={cn(
                "inline-flex items-center gap-1 self-start rounded-sm border border-border bg-surface-raised px-1.5 py-0.5",
                "font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
              title={`Fetch this assistant turn from ${selectedEndpointName ?? "the chatbot endpoint"}`}
            >
              {fetchMut.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {fetchMut.isPending
                ? "Fetching chatbot…"
                : isEmpty
                  ? "Fetch chatbot reply"
                  : "Re-fetch chatbot reply"}
            </button>
          )}

          {isAssistant && (
            <div className="mt-1 flex flex-col gap-1 self-stretch rounded-md border border-dashed border-border bg-surface-sunken/40 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setExpectedOpen((v) => !v)}
                  className="flex items-center gap-1 font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text"
                  title="The 'ground truth' answer this turn is graded against."
                >
                  {expectedOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Expected answer
                  {expected.trim() && (
                    <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpectedGenError(null);
                    generateExpectedMut.mutate();
                  }}
                  disabled={
                    generateExpectedMut.isPending || !priorUserContent.trim()
                  }
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 py-0.5",
                    "font-sans text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted hover:text-text",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                  title="Generate the expected answer from your documents"
                >
                  {generateExpectedMut.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  {generateExpectedMut.isPending ? "Generating…" : "Generate"}
                </button>
              </div>
              {expectedOpen && (
                <textarea
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  rows={2}
                  placeholder="What the bot should have said — used as the graded reference"
                  className={cn(
                    "min-h-[44px] w-full resize-y rounded-md border border-border bg-surface-raised px-2 py-1.5",
                    "font-sans text-[13px] leading-[18px] text-text placeholder:text-text-subtle",
                    "focus:outline-none focus:ring-1 focus:ring-accent",
                  )}
                />
              )}
              {expectedGenError && (
                <p className="font-sans text-[11px] text-danger" role="alert">
                  {expectedGenError}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Below-bubble meta line: role label + hover actions */}
        <div
          className={cn(
            "flex items-center gap-2 px-1 font-sans text-[10px] uppercase leading-[14px] tracking-[0.08em] text-text-subtle",
            isUser ? "flex-row-reverse" : "flex-row",
          )}
        >
          {isTool ? (
            <span className="inline-flex h-[18px] items-center rounded-sm bg-warn-soft px-1.5 font-sans text-[10px] font-semibold uppercase tracking-[0.04em] text-warn">
              tool
            </span>
          ) : (
            <span className="font-semibold">{role}</span>
          )}
          <div
            className={cn(
              "flex items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-ev",
              "group-hover/row:opacity-100 focus-within:opacity-100",
            )}
          >
            <MetaButton label="Edit" onClick={focusTextarea}>
              <Pencil className="h-3 w-3" />
            </MetaButton>
            {isAssistant && selectedEndpointId && (
              <MetaButton
                label={
                  fetchMut.isPending
                    ? "Fetching…"
                    : `Fetch reply from ${selectedEndpointName ?? "endpoint"}`
                }
                disabled={fetchMut.isPending || !priorUserContent.trim()}
                onClick={() => {
                  setFetchError(null);
                  fetchMut.mutate();
                }}
              >
                {fetchMut.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
              </MetaButton>
            )}
            <MetaButton label="Move up" disabled={index === 0} onClick={onMoveUp}>
              <ArrowUp className="h-3 w-3" />
            </MetaButton>
            <MetaButton
              label="Move down"
              disabled={index === total - 1}
              onClick={onMoveDown}
            >
              <ArrowDown className="h-3 w-3" />
            </MetaButton>
            <MetaButton label="Delete" onClick={onDelete} danger>
              <Trash2 className="h-3 w-3" />
            </MetaButton>
          </div>
        </div>
      </div>

      {/* Insert-below seam */}
      <div
        className={cn(
          "relative flex h-4 w-full items-center",
          isUser ? "justify-end" : "justify-start",
        )}
      >
        <div
          aria-hidden
          className={cn(
            "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-opacity duration-fast ease-ev",
            insertOpen ? "opacity-100" : "opacity-0 group-hover/row:opacity-60",
          )}
        />
        {insertOpen ? (
          <div className="relative z-10 flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2 py-1 shadow-elev-1">
            <span className="font-sans text-[10px] uppercase tracking-[0.06em] text-text-subtle">
              Insert
            </span>
            {ROLE_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  onInsertBelow(r);
                  setInsertOpen(false);
                }}
                className="h-6 rounded-sm px-1.5 font-sans text-[12px] text-text hover:bg-surface-sunken"
              >
                {r}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setInsertOpen(false)}
              aria-label="Cancel insert"
              className="px-1 font-sans text-[12px] text-text-muted hover:text-text"
            >
              ×
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setInsertOpen(true)}
            className={cn(
              "relative z-10 inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised px-2 py-0.5 font-sans text-[10px] uppercase tracking-[0.06em] text-text-muted shadow-elev-1",
              "opacity-0 transition-opacity duration-fast ease-ev hover:text-text group-hover/row:opacity-100",
            )}
          >
            <Plus className="h-3 w-3" />
            Insert
          </button>
        )}
      </div>
    </div>
  );
}

function MetaButton({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded-sm",
        "transition-colors duration-fast ease-ev",
        "disabled:pointer-events-none disabled:opacity-30",
        danger
          ? "text-text-subtle hover:bg-danger-soft hover:text-danger"
          : "text-text-subtle hover:bg-surface-sunken hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

const AutoResizeTextarea = React.forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    onBlur: () => void;
    onFocus?: () => void;
    placeholder?: string;
    variant?: "default" | "system" | "tool" | "bubble";
  }
>(function AutoResizeTextarea(
  { value, onChange, onBlur, onFocus, placeholder, variant = "default" },
  forwardedRef,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
  const setRefs = React.useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (typeof forwardedRef === "function") forwardedRef(el);
      else if (forwardedRef) forwardedRef.current = el;
    },
    [forwardedRef],
  );
  const isBubble = variant === "bubble";
  const minH = isBubble ? 24 : 60;

  React.useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minH, el.scrollHeight)}px`;
  }, [value, minH]);

  if (isBubble) {
    // Mirror pattern: a hidden, content-bearing div sets the natural width
    // of the wrapper; the textarea overlays it. Wrapping happens within the
    // mirror (`whitespace-pre-wrap break-words`), so the bubble grows in
    // both directions until it hits the parent's max-w cap.
    const display = value.length > 0 ? value : placeholder || " ";
    return (
      <div className="relative w-fit max-w-full">
        <div
          aria-hidden
          className={cn(
            "invisible whitespace-pre-wrap break-words pr-[1ch]",
            "font-sans text-[14px] leading-[22px]",
          )}
          style={{ minHeight: minH, minWidth: "10ch" }}
        >
          {display}
          {/* Trailing newline keeps the mirror height in sync when the
              user adds a blank line at the end. */}
          {"\n"}
        </div>
        <textarea
          ref={setRefs}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder={placeholder}
          className={cn(
            "absolute inset-0 block resize-none border-0 bg-transparent p-0",
            "font-sans text-[14px] leading-[22px] text-text placeholder:text-text-subtle",
            "focus:outline-none focus:ring-0",
          )}
          style={{ minHeight: minH }}
        />
      </div>
    );
  }

  const variantCls =
    variant === "system"
      ? "font-serif italic text-[15px] leading-[24px] bg-info-soft/40 border-info/30"
      : variant === "tool"
        ? "font-mono text-[13px] leading-[20px] bg-warn-soft/40 border-warn/30"
        : "font-sans text-[14px] leading-[22px] bg-surface-raised border-border-strong";

  return (
    <textarea
      ref={setRefs}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      className={cn(
        "block w-full resize-none rounded-md border px-3 py-2",
        "text-text placeholder:text-text-subtle",
        "focus:border-accent focus:shadow-focus-ring focus:outline-none",
        "transition-colors duration-fast ease-ev",
        variantCls,
      )}
      style={{ minHeight: minH }}
    />
  );
});

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { label: string; value: T }[];
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface-sunken p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-8 rounded-[6px] px-3 font-sans text-[13px] font-medium",
            "transition-colors duration-fast ease-ev",
            value === opt.value ? "bg-text text-bg" : "text-text-muted hover:text-text",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ResultsEmpty() {
  return (
    <div className="py-10 text-center">
      <p className="mx-auto max-w-[28ch] font-serif text-[16px] leading-[26px] text-text-muted">
        Run an evaluation to see per-turn scores.
      </p>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[140px] rounded-lg border border-border bg-surface-sunken" />
      ))}
    </div>
  );
}

function ErrorPanel({ error }: { error: Error }) {
  const detail =
    error instanceof ApiError &&
    typeof error.body === "object" &&
    error.body !== null &&
    "detail" in error.body
      ? ` — ${String((error.body as { detail: unknown }).detail)}`
      : "";
  return (
    <div
      role="alert"
      className="rounded-md border border-danger bg-danger-soft px-4 py-3 font-sans text-[14px] leading-[22px] text-danger"
    >
      <div className="mb-1 font-semibold">Evaluation failed</div>
      <div>
        {error.message}
        {detail}
      </div>
    </div>
  );
}

function ResultsPanel({
  result,
  projectId,
}: {
  result: ConversationEvaluationResult;
  projectId: string;
}) {
  const s = result.summary;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border bg-surface-raised p-3">
        <div className="mb-2 font-sans text-[11px] font-semibold uppercase leading-[14px] tracking-[0.04em] text-text-muted">
          Summary · {s.turn_count} turns
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono tabular-nums">
          <SummaryStat label="Avg" value={s.average_combined} />
          <SummaryStat label="Min" value={s.min_combined} />
          <SummaryStat label="Max" value={s.max_combined} />
        </div>
      </div>

      <ul className="flex flex-col gap-3">
        {result.turn_evaluations.map((t, i) => (
          <li key={t.message_id}>
            <TurnCard turn={t} index={i} projectId={projectId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="text-center">
      <div className="font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
        {label}
      </div>
      <div className="font-serif text-[22px] font-medium leading-[30px] text-text">
        {value == null ? "—" : value.toFixed(1)}
      </div>
    </div>
  );
}

function TurnCard({
  turn,
  index,
  projectId,
}: {
  turn: TurnEvaluation;
  index: number;
  projectId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const score = turn.ai_score ?? turn.combined_score ?? Number.NaN;
  return (
    <div className="relative rounded-lg border border-border bg-surface-raised p-3">
      <button
        type="button"
        onClick={() => setSaveOpen(true)}
        title="Save to dataset"
        aria-label="Save to dataset"
        className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text"
      >
        <BookmarkPlus className="h-3.5 w-3.5" />
      </button>
      <div className="mb-2 flex items-center justify-between pr-7">
        <div className="font-sans text-[13px] font-semibold leading-[18px] text-text">
          Turn {index + 1}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 font-sans text-[12px] text-text-muted hover:text-text"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Details
        </button>
      </div>
      <SaveToDatasetDialog
        projectId={projectId}
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        defaultValues={{
          question: turn.user_prompt,
          expected_response: turn.reference_answer ?? "",
          chatbot_response: turn.assistant_response,
          tags: [],
        }}
      />

      <div className="mb-3">
        <SmallTile label="Score" value={score} primary />
      </div>

      <TurnTokenRow turn={turn} />

      <div className="mb-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
        <div className="mb-1 font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
          User prompt
        </div>
        <div className="whitespace-pre-wrap font-sans text-[13px] leading-[20px] text-text">
          {turn.user_prompt || "—"}
        </div>
      </div>
      <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
        <div className="mb-1 font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
          Assistant response
        </div>
        <div className="whitespace-pre-wrap font-sans text-[13px] leading-[20px] text-text">
          {turn.assistant_response || "—"}
        </div>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {turn.reference_answer && (
            <DetailBlock title="Reference answer">
              <p className="whitespace-pre-wrap font-serif text-[14px] leading-[22px] text-text">
                {turn.reference_answer}
              </p>
            </DetailBlock>
          )}
          {turn.rationale && (
            <DetailBlock title="Rationale">
              <p className="whitespace-pre-wrap font-serif text-[14px] leading-[22px] text-text">
                {turn.rationale}
              </p>
            </DetailBlock>
          )}
          {turn.guideline_findings.length > 0 && (
            <DetailBlock title="Findings">
              <ul className="flex flex-col gap-2">
                {turn.guideline_findings.map((f, j) => (
                  <FindingRow key={j} finding={f} />
                ))}
              </ul>
            </DetailBlock>
          )}
        </div>
      )}
    </div>
  );
}

function SmallTile({
  label,
  value,
  primary,
}: {
  label: string;
  value: number | null | undefined;
  primary?: boolean;
}) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
  return (
    <div className="overflow-hidden">
      <ScoreTile label={label} value={v} primary={primary} size="sm" className="rounded-md" />
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-sans text-[11px] uppercase tracking-[0.04em] text-text-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function FindingRow({ finding }: { finding: GuidelineFindingOut }) {
  const severity = normaliseSeverity(finding.severity);
  return (
    <li className="rounded-md border border-border bg-surface p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <Badge variant={SEVERITY_VARIANT[severity]}>{severity}</Badge>
        <span className="truncate font-sans text-[12px] text-text-muted">
          {finding.guideline_excerpt}
        </span>
      </div>
      <div className="rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-[12px] leading-[18px] text-text">
        &ldquo;{finding.offending_span}&rdquo;
      </div>
      <p className="mt-1 font-sans text-[13px] leading-[20px] text-text">{finding.reason}</p>
    </li>
  );
}

function NewConversationDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string) => void | Promise<void>;
}) {
  const [title, setTitle] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setTitle("");
      setSubmitting(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="New conversation">
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1.5 block font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
            Title
          </label>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Refund flow with tool calls"
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!title.trim() || submitting}
            onClick={async () => {
              setSubmitting(true);
              await onCreate(title.trim());
            }}
          >
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function EditorEmptyState() {
  return (
    <div className="py-16 text-center">
      <p className="mx-auto max-w-[40ch] font-serif text-[18px] leading-[26px] text-text-muted">
        Select a conversation on the left, or create a new one to start building a multi-turn
        evaluation.
      </p>
    </div>
  );
}

function TurnTokenRow({ turn }: { turn: TurnEvaluation }) {
  const j = turn.judge_total_tokens ?? 0;
  const r = turn.reference_total_tokens ?? 0;
  const c = turn.chatbot_total_tokens ?? 0;
  if (!j && !r && !c) return null;
  const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
  const cells: { label: string; prompt: number; completion: number; total: number }[] = [
    {
      label: "Judge",
      prompt: turn.judge_prompt_tokens ?? 0,
      completion: turn.judge_completion_tokens ?? 0,
      total: j,
    },
    {
      label: "Reference",
      prompt: turn.reference_prompt_tokens ?? 0,
      completion: turn.reference_completion_tokens ?? 0,
      total: r,
    },
    {
      label: "Chatbot",
      prompt: turn.chatbot_prompt_tokens ?? 0,
      completion: turn.chatbot_completion_tokens ?? 0,
      total: c,
    },
  ];
  return (
    <div className="mb-2">
      <div className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.04em] text-text-muted">
        Token usage
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {cells.map((cell) => (
          <span
            key={cell.label}
            title={`prompt ${fmt(cell.prompt)} → completion ${fmt(
              cell.completion,
            )} → total ${fmt(cell.total)}`}
            className="font-mono text-[12px] tabular-nums text-text-muted"
          >
            <span className="mr-1 font-sans text-[11px] uppercase tracking-[0.04em] opacity-80">
              {cell.label}
            </span>
            {fmt(cell.total)}
          </span>
        ))}
      </div>
    </div>
  );
}
