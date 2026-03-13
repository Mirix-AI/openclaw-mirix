export type MirixRole = "user" | "assistant" | "system";

export type MirixContentItem = {
  type: "text";
  text: string;
};

export type MirixMessage = {
  role: MirixRole;
  content: MirixContentItem[];
};

export type MirixPluginConfig = {
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  providerApiKey?: string;
  model?: string;
  autoInitialize?: boolean;
  autoRecall?: boolean;
  autoCapture?: boolean;
  recallLimit?: number;
  searchMethod?: "bm25" | "embedding";
  searchToolName?: "search_memory" | "search_mirix_memory";
  userIdMode?: "session" | "agent" | "fixed";
  fixedUserId?: string;
  userIdPrefix?: string;
  filterTags?: Record<string, unknown>;
  debug?: boolean;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
};

type SessionLike = {
  sessionId?: string;
  sessionKey?: string;
  key?: string;
};

type ContextLike = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  session?: SessionLike;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getCurrentSessionKey?: () => string | undefined;
  };
};

type EnsureResult = {
  userId: string;
  metaAgentId?: string;
};

const DEFAULT_BASE_URL = "https://api.mirix.io";
const META_AGENT_CACHE = new Map<string, string>();
const USER_CACHE = new Set<string>();

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function maybeJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  return JSON.stringify(value);
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return "";
}

export function extractPromptText(event: { prompt?: unknown; messages?: unknown[] }): string {
  if (typeof event.prompt === "string" && event.prompt.trim()) {
    return event.prompt.trim();
  }

  if (Array.isArray(event.messages)) {
    const lastUser = [...event.messages]
      .reverse()
      .find((message) => message && typeof message === "object" && (message as { role?: string }).role === "user");
    if (lastUser && typeof lastUser === "object") {
      const content = flattenText((lastUser as { content?: unknown }).content);
      if (content.trim()) return content.trim();
    }
  }

  return "";
}

export function deriveUserId(config: MirixPluginConfig, ctx: ContextLike): string {
  const prefix = config.userIdPrefix || "openclaw";
  const agentId = ctx.agentId || "main";
  const sessionKey =
    ctx.sessionKey ||
    ctx.session?.sessionKey ||
    ctx.session?.key ||
    ctx.sessionManager?.getCurrentSessionKey?.() ||
    ctx.sessionId ||
    ctx.session?.sessionId ||
    ctx.sessionManager?.getSessionFile?.() ||
    "main";

  if (config.userIdMode === "fixed" && config.fixedUserId) {
    return config.fixedUserId;
  }

  if (config.userIdMode === "agent") {
    return `${prefix}:${agentId}`;
  }

  return `${prefix}:${agentId}:${sessionKey}`;
}

export function toMirixMessages(messages: Array<{ role?: unknown; content?: unknown }>): MirixMessage[] {
  return messages
    .map((message) => {
      const role = String(message.role || "user") as MirixRole;
      const text = flattenText(message.content).trim();
      if (!text) return null;
      return {
        role,
        content: [{ type: "text", text }],
      } satisfies MirixMessage;
    })
    .filter((message): message is MirixMessage => Boolean(message));
}

export function tailConversation(
  messages: Array<{ role?: unknown; content?: unknown }>,
  maxItems = 4,
): MirixMessage[] {
  const normalized = toMirixMessages(messages);
  if (normalized.length <= maxItems) {
    return normalized;
  }
  return normalized.slice(-maxItems);
}

export function latestExchange(
  messages: Array<{ role?: unknown; content?: unknown }>,
): MirixMessage[] {
  const normalized = toMirixMessages(messages);
  if (!normalized.length) {
    return [];
  }

  let lastAssistantIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex === -1) {
    return normalized.slice(-2);
  }

  let previousUserIndex = -1;
  for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
    if (normalized[index]?.role === "user") {
      previousUserIndex = index;
      break;
    }
  }

  if (previousUserIndex === -1) {
    return normalized.slice(Math.max(0, lastAssistantIndex - 1));
  }

  return normalized.slice(previousUserIndex, lastAssistantIndex + 1);
}

export function formatMemoryContext(payload: any): string {
  const memories = payload?.memories;
  if (!memories || typeof memories !== "object") {
    return "";
  }

  const lines: string[] = [];
  const memoryTypes = Object.entries(memories) as Array<[string, any]>;

  for (const [memoryType, bucket] of memoryTypes) {
    const items = Array.isArray(bucket?.items) ? bucket.items : [];
    if (!items.length) continue;
    lines.push(`## ${memoryType}`);
    for (const item of items) {
      const summary =
        item?.summary ||
        item?.name ||
        item?.caption ||
        item?.details ||
        item?.content ||
        JSON.stringify(item);
      lines.push(`- ${String(summary).replace(/\s+/g, " ").trim()}`);
    }
  }

  return lines.join("\n");
}

export class MirixRemoteClient {
  readonly config: MirixPluginConfig;

  constructor(config: MirixPluginConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return Boolean(this.config.apiKey);
  }

  get baseUrl(): string {
    return normalizeBaseUrl(this.config.baseUrl);
  }

  get status() {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      provider: this.config.provider || "openai",
      autoInitialize: this.config.autoInitialize !== false,
      autoRecall: this.config.autoRecall !== false,
      autoCapture: this.config.autoCapture !== false,
      recallLimit: this.config.recallLimit || 6,
      userIdMode: this.config.userIdMode || "session",
      searchToolName: this.config.searchToolName || "search_mirix_memory",
    };
  }

  async request(path: string, options: RequestOptions = {}): Promise<any> {
    if (!this.config.apiKey) {
      throw new Error("Mirix API key is missing. Set plugins.entries.openclaw-mirix.config.apiKey.");
    }

    const method = options.method || "GET";
    const url = new URL(`${this.baseUrl}${path}`);

    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value == null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.config.apiKey,
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const detail = data?.detail || response.statusText || "Unknown Mirix API error";
      throw new Error(`${method} ${path} failed: ${detail}`);
    }

    return data;
  }

  async ensureInitialized(ctx: ContextLike): Promise<EnsureResult> {
    const userId = deriveUserId(this.config, ctx);
    const cacheKey = `${this.baseUrl}:${this.config.apiKey || ""}`;
    let metaAgentId = META_AGENT_CACHE.get(cacheKey);

    if (this.config.autoInitialize !== false && !metaAgentId) {
      const payload: Record<string, unknown> = {
        update_agents: true,
      };

      if (this.config.provider) {
        payload.provider = this.config.provider;
      } else {
        payload.provider = "openai";
      }

      if (this.config.providerApiKey) payload.api_key = this.config.providerApiKey;
      if (this.config.model) payload.model = this.config.model;

      const metaAgent = await this.request("/agents/meta/initialize", {
        method: "POST",
        body: payload,
      });

      metaAgentId = metaAgent?.id;
      if (metaAgentId) {
        META_AGENT_CACHE.set(cacheKey, metaAgentId);
      }
    }

    const userCacheKey = `${cacheKey}:${userId}`;
    if (!USER_CACHE.has(userCacheKey)) {
      await this.request("/users/create_or_get", {
        method: "POST",
        body: {
          user_id: userId,
          name: userId,
        },
      });
      USER_CACHE.add(userCacheKey);
    }

    return { userId, metaAgentId };
  }

  async addConversation(
    ctx: ContextLike,
    messages: MirixMessage[],
    extra: {
      filterTags?: Record<string, unknown>;
      occurredAt?: string;
      asyncAdd?: boolean;
      rawInput?: unknown;
    } = {},
  ): Promise<any> {
    const { userId, metaAgentId } = await this.ensureInitialized(ctx);
    const agentId =
      metaAgentId || META_AGENT_CACHE.get(`${this.baseUrl}:${this.config.apiKey || ""}`);

    if (!agentId) {
      throw new Error("Mirix meta agent is not initialized.");
    }

    return this.request("/memory/add", {
      method: "POST",
      body: {
        user_id: userId,
        meta_agent_id: agentId,
        messages,
        filter_tags: { ...(this.config.filterTags || {}), ...(extra.filterTags || {}) },
        async_add: extra.asyncAdd ?? true,
        raw_input: extra.rawInput,
        occurred_at: extra.occurredAt,
      },
    });
  }

  async retrieveWithConversation(
    ctx: ContextLike,
    messages: MirixMessage[],
    extra: {
      limit?: number;
      filterTags?: Record<string, unknown>;
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<any> {
    const { userId } = await this.ensureInitialized(ctx);
    return this.request("/memory/retrieve/conversation", {
      method: "POST",
      body: {
        user_id: userId,
        messages,
        limit: extra.limit || this.config.recallLimit || 6,
        filter_tags: { ...(this.config.filterTags || {}), ...(extra.filterTags || {}) },
        start_date: extra.startDate,
        end_date: extra.endDate,
      },
    });
  }

  async search(
    ctx: ContextLike,
    query: string,
    extra: {
      memoryType?: string;
      searchField?: string;
      searchMethod?: "bm25" | "embedding";
      limit?: number;
      filterTags?: Record<string, unknown>;
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<any> {
    const { userId } = await this.ensureInitialized(ctx);
    return this.request("/memory/search", {
      params: {
        user_id: userId,
        query,
        memory_type: extra.memoryType || "all",
        search_field: extra.searchField || "null",
        search_method: extra.searchMethod || this.config.searchMethod || "embedding",
        limit: extra.limit || this.config.recallLimit || 6,
        filter_tags: maybeJson({ ...(this.config.filterTags || {}), ...(extra.filterTags || {}) }),
        start_date: extra.startDate,
        end_date: extra.endDate,
      },
    });
  }

  explainError(error: unknown): string {
    return stringifyError(error);
  }
}
