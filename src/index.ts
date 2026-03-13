import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import {
  MirixRemoteClient,
  extractPromptText,
  formatMemoryContext,
  latestExchange,
  tailConversation,
  toMirixMessages,
} from "./mirix-client.js";

type RegisterApi = {
  config?: any;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
  registerGatewayMethod?: (name: string, handler: (ctx: any) => unknown) => void;
  registerCommand?: (spec: {
    name: string;
    description: string;
    handler: (ctx: any) => { text: string };
  }) => void;
  registerCli?: (
    register: (ctx: { program: any }) => void,
    meta?: { commands?: string[] },
  ) => void;
  registerTool?: (spec: any, options?: any) => void;
  on?: (eventName: string, handler: (event: any, ctx: any) => Promise<any> | any) => void;
};

function getPluginConfig(api: RegisterApi) {
  return api.config?.plugins?.entries?.["mirix-memory"]?.config || {};
}

function getClient(api: RegisterApi) {
  return new MirixRemoteClient(getPluginConfig(api));
}

function log(api: RegisterApi, level: "info" | "warn" | "error" | "debug", ...args: unknown[]) {
  api.logger?.[level]?.(...args);
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

async function promptIfMissing(
  rl: readline.Interface,
  value: string | undefined,
  prompt: string,
): Promise<string> {
  if (value && value.trim()) {
    return value.trim();
  }
  return (await rl.question(prompt)).trim();
}

function getOpenClawConfigPath(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

async function readOpenClawConfig(): Promise<any> {
  const configPath = getOpenClawConfigPath();

  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeOpenClawConfig(config: any): Promise<string> {
  const configPath = getOpenClawConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

async function setupMirixConfig(
  api: RegisterApi,
  options: {
    apiKey?: string;
    baseUrl?: string;
    searchToolName?: string;
  } = {},
): Promise<{
  configPath: string;
  searchToolName: "search_memory" | "search_mirix_memory";
}> {
  const current = getPluginConfig(api);
  const rl = readline.createInterface({ input, output });

  try {
    const apiKey = await promptIfMissing(rl, options.apiKey, "Mirix API key: ");
    if (!apiKey) {
      throw new Error("Mirix API key is required.");
    }

    const baseUrl = await promptIfMissing(
      rl,
      options.baseUrl,
      `Mirix API URL [${current.baseUrl || "https://api.mirix.io"}]: `,
    );

    const searchToolInput = await promptIfMissing(
      rl,
      options.searchToolName,
      `Detailed search tool name [${current.searchToolName || "search_mirix_memory"}]: `,
    );

    const searchToolName =
      searchToolInput === "search_memory" ? "search_memory" : "search_mirix_memory";

    const config = await readOpenClawConfig();
    const plugins = (config.plugins ??= {});
    const slots = (plugins.slots ??= {});
    const entries = (plugins.entries ??= {});

    slots.memory = "mirix-memory";
    entries["mirix-memory"] = {
      enabled: true,
      config: {
        apiKey,
        baseUrl: baseUrl || current.baseUrl || "https://api.mirix.io",
        provider: current.provider || "openai",
        autoInitialize: current.autoInitialize !== false,
        autoRecall: current.autoRecall !== false,
        autoCapture: current.autoCapture !== false,
        recallLimit: current.recallLimit || 6,
        searchMethod: current.searchMethod || "embedding",
        searchToolName,
        userIdMode: current.userIdMode || "session",
        userIdPrefix: current.userIdPrefix || "openclaw",
      },
    };

    const configPath = await writeOpenClawConfig(config);
    return { configPath, searchToolName };
  } finally {
    rl.close();
  }
}

function getSearchToolName(api: RegisterApi): "search_memory" | "search_mirix_memory" {
  const configured = getPluginConfig(api).searchToolName;
  if (configured === "search_memory" || configured === "search_mirix_memory") {
    return configured;
  }
  return "search_mirix_memory";
}

function searchToolParameters() {
  return Type.Object({
    query: Type.String(),
    memoryType: Type.Optional(Type.String()),
    searchField: Type.Optional(Type.String()),
    searchMethod: Type.Optional(Type.Union([Type.Literal("bm25"), Type.Literal("embedding")])),
    limit: Type.Optional(Type.Number()),
    filterTags: Type.Optional(Type.Record(Type.String(), Type.Any())),
    startDate: Type.Optional(Type.String()),
    endDate: Type.Optional(Type.String()),
  });
}

async function runDetailedSearch(api: RegisterApi, runtime: any, params: any) {
  const client = getClient(api);
  const payload = await client.search(runtime || {}, params.query, {
    memoryType: params.memoryType,
    searchField: params.searchField,
    searchMethod: params.searchMethod,
    limit: params.limit,
    filterTags: params.filterTags,
    startDate: params.startDate,
    endDate: params.endDate,
  });
  return textResult(JSON.stringify(payload, null, 2));
}

export default {
  id: "mirix-memory",
  name: "Mirix Memory",
  register(api: RegisterApi) {
    api.registerGatewayMethod?.("mirix.status", async ({ respond }: any) => {
      const client = getClient(api);
      respond?.(true, client.status);
    });

    api.registerCommand?.({
      name: "mirix-status",
      description: "Show Mirix memory plugin status",
      handler: () => {
        const client = getClient(api);
        return { text: JSON.stringify(client.status, null, 2) };
      },
    });

    api.registerCli?.(
      ({ program }) => {
        const mirix = program.command("mirix").description("Mirix memory plugin helpers");

        mirix
          .command("setup")
          .description("Prompt for the Mirix API key and write OpenClaw config")
          .option("--api-key <apiKey>", "Mirix API key")
          .option("--base-url <baseUrl>", "Mirix API URL")
          .option(
            "--search-tool-name <searchToolName>",
            "Detailed search tool name: search_mirix_memory or search_memory",
          )
          .action(async (options: any) => {
            try {
              const result = await setupMirixConfig(api, options);
              console.log(`Mirix config saved to ${result.configPath}`);
              console.log(`Detailed search tool: ${result.searchToolName}`);
              console.log("Restart the OpenClaw gateway to load the updated config.");
            } catch (error) {
              const client = getClient(api);
              console.error(`Mirix setup failed: ${client.explainError(error)}`);
              process.exitCode = 1;
            }
          });

        mirix
          .command("status")
          .description("Show Mirix memory plugin status")
          .action(() => {
            const client = getClient(api);
            console.log(JSON.stringify(client.status, null, 2));
          });
      },
      { commands: ["mirix"] },
    );

    api.registerTool?.({
      name: "mirix_memory",
      description: "Search, retrieve, capture, or inspect Mirix-backed memories.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("status"),
          Type.Literal("retrieve_conversation"),
          Type.Literal("search"),
          Type.Literal("add"),
        ]),
        query: Type.Optional(Type.String()),
        memoryType: Type.Optional(Type.String()),
        searchField: Type.Optional(Type.String()),
        searchMethod: Type.Optional(Type.Union([Type.Literal("bm25"), Type.Literal("embedding")])),
        limit: Type.Optional(Type.Number()),
        messages: Type.Optional(
          Type.Array(
            Type.Object({
              role: Type.String(),
              content: Type.Any(),
            }),
          ),
        ),
        filterTags: Type.Optional(Type.Record(Type.String(), Type.Any())),
        startDate: Type.Optional(Type.String()),
        endDate: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: any, runtime: any) {
        const client = getClient(api);

        try {
          if (params.action === "status") {
            return textResult(JSON.stringify(client.status, null, 2));
          }

          if (params.action === "retrieve_conversation") {
            const payload = await client.retrieveWithConversation(
              runtime || {},
              toMirixMessages(params.messages || []),
              {
                limit: params.limit,
                filterTags: params.filterTags,
                startDate: params.startDate,
                endDate: params.endDate,
              },
            );
            return textResult(JSON.stringify(payload, null, 2));
          }

          if (params.action === "search") {
            if (!params.query) {
              return textResult("Missing query.");
            }
            return runDetailedSearch(api, runtime, params);
          }

          if (params.action === "add") {
            const payload = await client.addConversation(
              runtime || {},
              toMirixMessages(params.messages || []),
              {
                filterTags: params.filterTags,
              },
            );
            return textResult(JSON.stringify(payload, null, 2));
          }

          return textResult(`Unsupported action: ${params.action}`);
        } catch (error) {
          return textResult(`Mirix error: ${client.explainError(error)}`);
        }
      },
    });

    api.registerTool?.({
      name: getSearchToolName(api),
      description: "Run a detailed Mirix memory search against /memory/search.",
      parameters: searchToolParameters(),
      async execute(_id: string, params: any, runtime: any) {
        try {
          return await runDetailedSearch(api, runtime, params);
        } catch (error) {
          const client = getClient(api);
          return textResult(`Mirix error: ${client.explainError(error)}`);
        }
      },
    });

    api.on?.("before_agent_start", async (event: any, ctx: any) => {
      const client = getClient(api);
      if (!client.enabled || getPluginConfig(api).autoRecall === false) {
        return;
      }

      const prompt = extractPromptText(event);
      if (!prompt) {
        return;
      }

      try {
        const recentMessages = Array.isArray(event?.messages) ? tailConversation(event.messages) : [];
        const memories = await client.retrieveWithConversation(
          ctx || {},
          recentMessages.length
            ? recentMessages
            : [
                {
                  role: "user",
                  content: [{ type: "text", text: prompt }],
                },
              ],
        );
        const memoryContext = formatMemoryContext(memories);
        if (!memoryContext) {
          return;
        }

        return {
          systemPrompt: `${event.systemPrompt || ""}\n\n[Mirix memory context]\nUse the following retrieved memories when relevant.\n${memoryContext}`,
        };
      } catch (error) {
        log(api, "warn", "[mirix-memory] recall failed", client.explainError(error));
        return;
      }
    });

    api.on?.("agent_end", async (event: any, ctx: any) => {
      const client = getClient(api);
      if (!client.enabled || getPluginConfig(api).autoCapture === false) {
        return;
      }

      try {
        const rawMessages = Array.isArray(event?.messages) ? event.messages : [];
        const messages = latestExchange(rawMessages);
        if (!messages.length) {
          return;
        }

        await client.addConversation(ctx || {}, messages, {
          rawInput: rawMessages,
        });
      } catch (error) {
        log(api, "warn", "[mirix-memory] capture failed", client.explainError(error));
      }
    });

    log(api, "info", "[mirix-memory] plugin registered");
  },
};
