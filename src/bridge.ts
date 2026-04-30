#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Bot, GrammyError } from "grammy";
import type { CallbackQuery, Message, User } from "grammy/types";
import WebSocket from "ws";
import {
  BridgeState,
  chunkText,
  defaultStateDir,
  ensureDir,
  gatePrivateMessage,
  isAllowlisted,
  loadDotEnv,
  normalizeCwd,
  paths,
  readAccess,
  readBridgeState,
  writeBridgeState,
} from "./common.js";

loadDotEnv();

const STATE = paths();
ensureDir(STATE.stateDir);
ensureDir(STATE.logsDir);
ensureDir(STATE.notificationsDir);
writeFileSync(STATE.bridgePidFile, String(process.pid), { mode: 0o600 });

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CODEX_APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:17345";
const CODEX_BRIDGE_CWD = process.env.CODEX_BRIDGE_CWD ?? process.cwd();
const CODEX_MODEL = process.env.CODEX_MODEL || undefined;
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || undefined;
const STREAM_EDITS = process.env.CODEX_TELEGRAM_STREAM_EDITS === "1";
const SHOW_PROGRESS = process.env.CODEX_TELEGRAM_PROGRESS === "1";
const DIFF_MAX_CHARS = readPositiveInt(process.env.CODEX_TELEGRAM_DIFF_MAX_CHARS, 30000);
const FILE_PREVIEW_MAX_CHARS = readPositiveInt(process.env.CODEX_TELEGRAM_FILE_PREVIEW_MAX_CHARS, 12000);
const FILE_ALL_MAX_CHARS = readPositiveInt(process.env.CODEX_TELEGRAM_FILE_ALL_MAX_CHARS, 60000);
const TELEGRAM_REQUEST_TIMEOUT_MS = readPositiveInt(process.env.CODEX_TELEGRAM_REQUEST_TIMEOUT_MS, 90000);

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error(`TELEGRAM_BOT_TOKEN is required. Set it in ${STATE.envFile}`);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json | undefined };
type TelegramUser = User;
type TelegramMessage = Message & {
  text?: string;
  caption?: string;
  chat: Message["chat"] & { type: string };
  from?: TelegramUser;
};
type TelegramCallbackQuery = CallbackQuery & {
  data?: string;
  message?: TelegramMessage;
};

class TelegramApi {
  constructor(private readonly bot: Bot) {}

  async sendMessage(chatId: string, text: string, extra: JsonObject = {}): Promise<TelegramMessage[]> {
    const sent: TelegramMessage[] = [];
    for (const chunk of chunkText(text || "(empty)")) {
      const message = await this.bot.api.sendMessage(chatId, chunk, {
        disable_web_page_preview: true,
        ...(extra as Record<string, unknown>),
      } as any);
      sent.push(message as TelegramMessage);
    }
    return sent;
  }

  editMessageText(chatId: string, messageId: number, text: string, extra: JsonObject = {}): Promise<TelegramMessage> {
    return this.bot.api.editMessageText(chatId, messageId, text.slice(0, 4096) || "(empty)", {
      disable_web_page_preview: true,
      ...(extra as Record<string, unknown>),
    } as any) as Promise<TelegramMessage>;
  }

  deleteMessage(chatId: string, messageId: number): Promise<true> {
    return this.bot.api.deleteMessage(chatId, messageId);
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<true> {
    return this.bot.api.answerCallbackQuery(callbackQueryId, text ? { text } : undefined);
  }

  sendTyping(chatId: string): Promise<true> {
    return this.bot.api.sendChatAction(chatId, "typing");
  }

  setReaction(chatId: string, messageId: number, emoji: string): Promise<true> {
    return this.bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }] as any);
  }
}

function sanitizeTelegramError(error: unknown, token = TELEGRAM_BOT_TOKEN, context?: string): Error {
  const raw = [context, describeTelegramError(error)].filter(Boolean).join(": ");
  const redacted = token ? raw.split(token).join("<redacted-token>") : raw;
  return new Error(redacted);
}

function describeTelegramError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const base = error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
  const cause = describeErrorCause(error.cause);
  return cause ? `${base} | cause: ${cause}` : base;
}

function describeErrorCause(cause: unknown, seen = new Set<unknown>()): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause !== "object") return String(cause);
  if (seen.has(cause)) return "[circular cause]";
  seen.add(cause);

  const record = cause as Record<string, unknown>;
  const prototypeName = Object.getPrototypeOf(cause)?.constructor?.name;
  const name = typeof record.name === "string" ? record.name : typeof prototypeName === "string" ? prototypeName : "Error";
  const message = typeof record.message === "string" && record.message !== name ? record.message : undefined;
  const attrs = ["code", "errno", "syscall", "hostname", "address", "port"]
    .map((key) => {
      const value = record[key];
      return value === undefined ? undefined : `${key}=${String(value)}`;
    })
    .filter((item): item is string => Boolean(item));
  const nested = describeErrorCause(record.cause, seen);
  return [name, message, attrs.length ? attrs.join(", ") : undefined, nested ? `cause: ${nested}` : undefined]
    .filter(Boolean)
    .join("; ");
}

function logTelegramError(context: string, error: unknown, options: { ignoreMessageNotModified?: boolean } = {}): void {
  const sanitized = sanitizeTelegramError(error);
  if (options.ignoreMessageNotModified && /message is not modified/i.test(sanitized.message)) return;
  console.error(`[${new Date().toISOString()}] Telegram ${context}: ${sanitized.message}`);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

class CodexClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private connectPromise: Promise<void> | undefined;
  private resumedThreads = new Set<string>();
  onNotification: (message: any) => void = () => {};
  onServerRequest: (message: any) => void = () => {};
  onClose: () => void = () => {};

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(CODEX_APP_SERVER_URL);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error(`timed out connecting to ${CODEX_APP_SERVER_URL}`));
      }, 10000);

      ws.on("open", () => {
        void this.request("initialize", {
          clientInfo: {
            name: "codex_telegram_bridge",
            title: "Codex Telegram Bridge",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        }).then(() => {
          this.notify("initialized", {});
          clearTimeout(timeout);
          resolve();
        }).catch(reject);
      });

      ws.on("message", (data) => this.handleMessage(String(data)));
      ws.on("error", () => reject(new Error(`WebSocket error connecting to ${CODEX_APP_SERVER_URL}`)));
      ws.on("close", () => {
        for (const [, pending] of this.pending) pending.reject(new Error("Codex app-server connection closed"));
        this.pending.clear();
        this.ws = undefined;
        this.connectPromise = undefined;
        this.resumedThreads.clear();
        this.onClose();
      });
    });

    return this.connectPromise;
  }

  request(method: string, params: JsonObject): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server is not connected"));
    }
    const id = this.nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: JsonObject): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ method, params }));
  }

  respond(id: number | string, result: JsonObject): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id, result }));
  }

  respondError(id: number | string, message: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id, error: { code: -32000, message } }));
  }

  async ensureThread(state: BridgeState): Promise<string> {
    await this.connect();
    const cwd = state.cwd ?? CODEX_BRIDGE_CWD;
    if (state.activeThreadId) {
      if (!this.resumedThreads.has(state.activeThreadId)) {
        await this.request("thread/resume", {
          threadId: state.activeThreadId,
          cwd,
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        this.resumedThreads.add(state.activeThreadId);
      }
      return state.activeThreadId;
    }

    const response = await this.request("thread/start", {
      cwd,
      ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = response.thread.id as string;
    writeBridgeState({ ...state, activeThreadId: threadId, cwd });
    this.resumedThreads.add(threadId);
    return threadId;
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.onServerRequest(message);
      return;
    }

    if (message.method) this.onNotification(message);
  }
}

type TelegramTurn = {
  turnId: string;
  threadId: string;
  chatId: string;
  statusMessageId: number;
  cwd: string;
  buffer: string;
  progressLines: string[];
  changedFiles: string[];
  diff: string;
  fileDiffs: Map<string, string>;
  cancelRequested: boolean;
  lastEditAt: number;
};

type TurnReport = {
  turnId: string;
  threadId: string;
  cwd: string;
  progressLines: string[];
  changedFiles: string[];
  diff: string;
  fileDiffs: Map<string, string>;
};

type PendingSteer = {
  chatId: string;
  text: string;
  threadId: string;
  turnId: string;
  createdAt: number;
};

type LocalNotification = {
  id?: string;
  text?: string;
  cwd?: string;
  createdAt?: string;
  source?: string;
};

const bot = new Bot(TELEGRAM_BOT_TOKEN, {
  client: { timeoutSeconds: Math.ceil(TELEGRAM_REQUEST_TIMEOUT_MS / 1000) },
});
const telegram = new TelegramApi(bot);
const codex = new CodexClient();
const telegramTurns = new Map<string, TelegramTurn>();
const pendingApprovals = new Map<string, { request: any; text: string }>();
const pendingSteers = new Map<string, PendingSteer>();
const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
let lastTurnReport: TurnReport | undefined;

let bridgeState = readBridgeState();
if (!bridgeState.cwd) bridgeState.cwd = CODEX_BRIDGE_CWD;

function persistState(patch: Partial<BridgeState>): void {
  bridgeState = { ...bridgeState, ...patch };
  writeBridgeState(bridgeState);
}

function currentCwd(): string {
  return bridgeState.cwd ?? CODEX_BRIDGE_CWD;
}

function describeUser(user?: TelegramUser): string {
  if (!user) return "unknown";
  return user.username ? `@${user.username}` : String(user.id);
}

async function setActiveThread(threadId: string, cwd?: string): Promise<void> {
  persistState({ activeThreadId: threadId, cwd: cwd ?? bridgeState.cwd ?? CODEX_BRIDGE_CWD });
}

codex.onNotification = (message) => {
  const params = message.params ?? {};

  if (message.method === "thread/started" && params.thread?.id) {
    void setActiveThread(params.thread.id, params.thread.cwd);
  }

  if (message.method === "thread/status/changed" && params.threadId) {
    if (params.status?.type === "active") persistState({ activeThreadId: params.threadId });
    if (params.status?.type === "idle" && bridgeState.activeThreadId === params.threadId) {
      persistState({ activeTurnId: undefined });
    }
  }

  if (message.method === "turn/started" && params.threadId && params.turn?.id) {
    persistState({ activeThreadId: params.threadId, activeTurnId: params.turn.id });
  }

  if (message.method === "turn/diff/updated") {
    updateTurnDiff(params.turnId, String(params.diff ?? ""));
  }

  if (message.method === "item/started") {
    const line = describeItemStarted(params.item);
    if (line) appendProgress(params.turnId, line);
  }

  if (message.method === "item/commandExecution/outputDelta") {
    const delta = String(params.delta ?? "").trim();
    if (delta) appendProgress(params.turnId, `Output: ${clip(oneLine(delta), 240)}`);
  }

  if (message.method === "item/fileChange/outputDelta") {
    const delta = String(params.delta ?? "").trim();
    if (delta) appendProgress(params.turnId, `Patch: ${clip(oneLine(delta), 240)}`);
  }

  if (message.method === "item/fileChange/patchUpdated") {
    addFileChanges(params.turnId, params.changes);
  }

  if (message.method === "item/mcpToolCall/progress") {
    if (params.message) appendProgress(params.turnId, String(params.message));
  }

  if (message.method === "item/agentMessage/delta") {
    const turn = telegramTurns.get(params.turnId);
    if (!turn) return;
    turn.buffer += params.delta ?? "";
    void maybeEditTurn(turn);
  }

  if (message.method === "item/completed") {
    const item = params.item;
    const turn = telegramTurns.get(params.turnId);
    if (!turn) return;
    if (item?.type === "agentMessage") {
      if (item.text && item.text.length > turn.buffer.length) turn.buffer = item.text;
      return;
    }
    if (item?.type === "fileChange") addFileChanges(params.turnId, item.changes);
    const line = describeItemCompleted(item);
    if (line) appendProgress(params.turnId, line, true);
  }

  if (message.method === "turn/completed") {
    if (bridgeState.activeTurnId === params.turn?.id) persistState({ activeTurnId: undefined });
    const turn = telegramTurns.get(params.turn?.id);
    if (!turn) return;
    telegramTurns.delete(params.turn.id);
    void finishTurn(turn, params.turn.status, params.turn.error)
      .catch((error) => logTelegramError("finish turn failed", error));
  }
};

codex.onServerRequest = (request) => {
  const key = randomBytes(3).toString("hex");
  const text = formatApprovalRequest(request, key);
  pendingApprovals.set(key, { request, text });

  const access = readAccess();
  for (const chatId of access.allowFrom) {
    void telegram.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: "Allow", callback_data: `ap:${key}:a` },
          { text: "Deny", callback_data: `ap:${key}:d` },
        ]],
      },
    }).catch((error) => logTelegramError("approval request send failed", error));
  }
};

async function maybeEditTurn(turn: TelegramTurn): Promise<void> {
  if (!STREAM_EDITS) return;
  await updateTurnMessage(turn);
}

async function updateTurnMessage(turn: TelegramTurn, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - turn.lastEditAt < 1200) return;
  turn.lastEditAt = now;
  const preview = renderWorkingTurn(turn);
  await telegram.editMessageText(turn.chatId, turn.statusMessageId, preview, turnReplyMarkupExtra(turn))
    .catch((error) => logTelegramError("working status edit failed", error, { ignoreMessageNotModified: true }));
}

function appendProgress(turnId: string | undefined, line: string | undefined, force = false): void {
  if (!SHOW_PROGRESS || !turnId || !line) return;
  const turn = telegramTurns.get(turnId);
  if (!turn) return;
  turn.progressLines ??= [];
  const normalized = line.trim();
  if (!normalized) return;
  if (turn.progressLines.at(-1) === normalized) return;
  turn.progressLines.push(normalized);
  if (turn.progressLines.length > 30) turn.progressLines.splice(0, turn.progressLines.length - 30);
  void updateTurnMessage(turn, force);
}

function updateTurnDiff(turnId: string | undefined, diff: string): void {
  if (!turnId) return;
  const turn = telegramTurns.get(turnId);
  if (!turn) return;
  turn.diff = diff;
  const parsed = parseUnifiedDiff(diff);
  mergeChangedFiles(turn, parsed.files);
  for (const [path, fileDiff] of parsed.fileDiffs) turn.fileDiffs.set(path, fileDiff);
}

function addFileChanges(turnId: string | undefined, changes: any): void {
  if (!turnId || !Array.isArray(changes)) return;
  const turn = telegramTurns.get(turnId);
  if (!turn) return;

  const files: string[] = [];
  for (const change of changes) {
    const path = normalizeRelativePath(String(change?.path ?? ""));
    if (!path) continue;
    files.push(path);
    const diff = String(change?.diff ?? "");
    if (diff) turn.fileDiffs.set(path, diff);
  }
  mergeChangedFiles(turn, files);
}

function mergeChangedFiles(turn: TelegramTurn, files: string[]): void {
  const seen = new Set(turn.changedFiles);
  for (const file of files) {
    const normalized = normalizeRelativePath(file);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    turn.changedFiles.push(normalized);
  }
}

async function finishTurn(turn: TelegramTurn, status: string, error: any): Promise<void> {
  stopTypingIndicator(turn.turnId);
  lastTurnReport = buildTurnReport(turn);
  if (status !== "completed") {
    const message = status === "interrupted" && turn.cancelRequested
      ? "Stopped current Codex turn."
      : error?.message ? `${status}: ${error.message}` : `Turn ${status}`;
    await telegram.editMessageText(
      turn.chatId,
      turn.statusMessageId,
      message,
      removeReplyMarkupExtra(),
    ).catch((editError) => logTelegramError("finish status edit failed", editError, { ignoreMessageNotModified: true }));
    return;
  }

  const finalText = renderFinalTurn(turn);
  const chunks = chunkText(finalText);
  await telegram.deleteMessage(turn.chatId, turn.statusMessageId).catch(async (deleteError) => {
    logTelegramError("working status delete failed", deleteError);
    await telegram.editMessageText(turn.chatId, turn.statusMessageId, "Done.", removeReplyMarkupExtra())
      .catch((editError) => logTelegramError("working status clear failed", editError, { ignoreMessageNotModified: true }));
  });
  for (const chunk of chunks.length ? chunks : ["Done."]) {
    try {
      await telegram.sendMessage(turn.chatId, chunk);
    } catch (sendError) {
      logTelegramError("final response send failed", sendError);
      break;
    }
  }
}

function renderWorkingTurn(turn: TelegramTurn): string {
  const parts = [turn.cancelRequested ? "Stopping current Codex turn..." : "Codex is working..."];
  if (STREAM_EDITS && turn.buffer.trim()) {
    parts.push("", clip(turn.buffer.trim(), 1200));
  }
  return clip(parts.join("\n"), 3900);
}

function turnReplyMarkupExtra(turn: TelegramTurn): JsonObject {
  return {
    reply_markup: turn.cancelRequested
      ? { inline_keyboard: [] }
      : { inline_keyboard: [[{ text: "Stop current turn", callback_data: `cx:${turn.turnId}` }]] },
  };
}

function removeReplyMarkupExtra(): JsonObject {
  return { reply_markup: { inline_keyboard: [] } };
}

function renderFinalTurn(turn: TelegramTurn): string {
  return turn.buffer.trim() || "Done.";
}

function startTypingIndicator(turn: TelegramTurn): void {
  stopTypingIndicator(turn.turnId);
  sendTypingIndicator(turn);
  const timer = setInterval(() => sendTypingIndicator(turn), 4000);
  unrefTimer(timer);
  typingTimers.set(turn.turnId, timer);
}

function sendTypingIndicator(turn: TelegramTurn): void {
  void telegram.sendTyping(turn.chatId).catch((error) => logTelegramError("typing indicator failed", error));
}

function stopTypingIndicator(turnId: string): void {
  const timer = typingTimers.get(turnId);
  if (timer) clearInterval(timer);
  typingTimers.delete(turnId);
}

function stopAllTypingIndicators(): void {
  for (const timer of typingTimers.values()) clearInterval(timer);
  typingTimers.clear();
}

function buildTurnReport(turn: TelegramTurn): TurnReport {
  const parsed = turn.diff ? parseUnifiedDiff(turn.diff) : { files: [], fileDiffs: new Map<string, string>() };
  const changedFiles = uniqueStrings([...turn.changedFiles, ...parsed.files]);
  const fileDiffs = new Map(parsed.fileDiffs);
  for (const [path, diff] of turn.fileDiffs) fileDiffs.set(path, diff);
  const diff = turn.diff || Array.from(fileDiffs.values()).filter(Boolean).join("\n");
  return {
    turnId: turn.turnId,
    threadId: turn.threadId,
    cwd: turn.cwd,
    progressLines: [...(turn.progressLines ?? [])],
    changedFiles,
    diff,
    fileDiffs,
  };
}

function parseUnifiedDiff(diff: string): { files: string[]; fileDiffs: Map<string, string> } {
  const files: string[] = [];
  const fileDiffs = new Map<string, string>();
  const lines = diff.split("\n");
  let currentPath = "";
  let currentLines: string[] = [];

  function flush(): void {
    if (!currentPath) return;
    const normalized = normalizeRelativePath(currentPath);
    if (!normalized) return;
    files.push(normalized);
    fileDiffs.set(normalized, currentLines.join("\n"));
  }

  for (const line of lines) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) {
      flush();
      currentPath = match[2];
      currentLines = [line];
      continue;
    }
    if (currentPath) currentLines.push(line);
  }
  flush();

  if (!files.length) {
    for (const line of lines) {
      const match = /^\+\+\+ b\/(.+)$/.exec(line);
      if (match) files.push(normalizeRelativePath(match[1]));
    }
  }

  return { files: uniqueStrings(files), fileDiffs };
}

function normalizeRelativePath(path: string): string {
  let normalized = path.trim();
  if (!normalized || normalized === "/dev/null") return "";
  normalized = normalized.replace(/\\/g, "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeRelativePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function describeItemStarted(item: any): string | undefined {
  if (!item) return undefined;
  switch (item.type) {
    case "commandExecution":
      return `Running: ${shortCommand(item.command)}`;
    case "mcpToolCall":
      return `Using ${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return `Using ${item.namespace ? `${item.namespace}.` : ""}${item.tool}`;
    case "webSearch":
      return `Searching web: ${shortCommand(item.query)}`;
    case "fileChange":
      return "Applying file changes";
    case "plan":
      return `Plan: ${clip(oneLine(item.text ?? ""), 180)}`;
    case "imageGeneration":
      return "Generating image";
    default:
      return undefined;
  }
}

function describeItemCompleted(item: any): string | undefined {
  if (!item) return undefined;
  switch (item.type) {
    case "commandExecution": {
      const lines = [`Ran: ${shortCommand(item.command)}`];
      if (typeof item.exitCode === "number" && item.exitCode !== 0) lines.push(`exit ${item.exitCode}`);
      const output = String(item.aggregatedOutput ?? "").trim();
      lines.push(output ? `Output:\n${clip(output, 900)}` : "Output: (no output)");
      return lines.join("\n");
    }
    case "mcpToolCall":
      return item.error
        ? `Failed ${item.server}.${item.tool}: ${clip(oneLine(item.error.message ?? JSON.stringify(item.error)), 220)}`
        : `Completed ${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return item.success === false
        ? `Failed ${item.namespace ? `${item.namespace}.` : ""}${item.tool}`
        : `Completed ${item.namespace ? `${item.namespace}.` : ""}${item.tool}`;
    case "fileChange":
      return `Applied file changes (${item.changes?.length ?? 0})`;
    case "webSearch":
      return `Searched web: ${shortCommand(item.query)}`;
    case "imageGeneration":
      return item.savedPath ? `Generated image: ${item.savedPath}` : "Generated image";
    default:
      return undefined;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shortCommand(value: string | undefined): string {
  return clip(oneLine(value ?? ""), 180);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatApprovalRequest(request: any, key: string): string {
  const method = request.method as string;
  const params = request.params ?? {};
  if (method === "item/commandExecution/requestApproval") {
    return [
      `Approval ${key}: command execution`,
      params.reason ? `Reason: ${params.reason}` : undefined,
      params.cwd ? `CWD: ${params.cwd}` : undefined,
      params.command ? `Command:\n${params.command}` : undefined,
    ].filter(Boolean).join("\n\n");
  }
  if (method === "item/fileChange/requestApproval") {
    return [
      `Approval ${key}: file change`,
      params.reason ? `Reason: ${params.reason}` : undefined,
      params.grantRoot ? `Grant root: ${params.grantRoot}` : undefined,
    ].filter(Boolean).join("\n\n");
  }
  if (method === "item/permissions/requestApproval") {
    return [
      `Approval ${key}: permissions`,
      params.reason ? `Reason: ${params.reason}` : undefined,
      `CWD: ${params.cwd ?? "-"}`,
      `Requested:\n${JSON.stringify(params.permissions ?? {}, null, 2)}`,
    ].join("\n\n");
  }
  return `Approval ${key}: ${method}\n\n${JSON.stringify(params, null, 2)}`;
}

function approveRequest(entry: { request: any }, allow: boolean): void {
  const { request } = entry;
  if (!allow) {
    if (request.method === "item/commandExecution/requestApproval") {
      codex.respond(request.id, { decision: "decline" });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      codex.respond(request.id, { decision: "decline" });
      return;
    }
    codex.respondError(request.id, "Declined from Telegram");
    return;
  }

  if (request.method === "item/commandExecution/requestApproval") {
    codex.respond(request.id, { decision: "accept" });
    return;
  }
  if (request.method === "item/fileChange/requestApproval") {
    codex.respond(request.id, { decision: "accept" });
    return;
  }
  if (request.method === "item/permissions/requestApproval") {
    const requested = request.params?.permissions ?? {};
    codex.respond(request.id, {
      permissions: {
        ...(requested.network ? { network: requested.network } : {}),
        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
      },
      scope: "turn",
    });
    return;
  }

  codex.respondError(request.id, `Approval from Telegram is not implemented for ${request.method}`);
}

async function requestTurnInterrupt(turn: TelegramTurn): Promise<void> {
  turn.cancelRequested = true;
  await updateTurnMessage(turn, true);
  await interruptTurn(turn.threadId, turn.turnId);
}

async function interruptTurn(threadId: string, turnId: string): Promise<void> {
  await codex.connect();
  await codex.request("turn/interrupt", {
    threadId,
    turnId,
  });
}

async function cancelActiveTurn(chatId: string): Promise<void> {
  const turn = bridgeState.activeTurnId ? telegramTurns.get(bridgeState.activeTurnId) : undefined;
  if (!turn) {
    if (bridgeState.activeThreadId && bridgeState.activeTurnId) {
      try {
        await interruptTurn(bridgeState.activeThreadId, bridgeState.activeTurnId);
        await telegram.sendMessage(chatId, "Stop requested for the current Codex turn.");
      } catch (error) {
        await telegram.sendMessage(chatId, `Stop failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
      }
      return;
    }
    await telegram.sendMessage(chatId, "No active Codex turn to stop.");
    return;
  }

  if (turn.cancelRequested) {
    await telegram.sendMessage(chatId, "Stop is already in progress.");
    return;
  }

  try {
    await requestTurnInterrupt(turn);
    await telegram.sendMessage(chatId, "Stop requested for the current Codex turn.");
  } catch (error) {
    turn.cancelRequested = false;
    await updateTurnMessage(turn, true);
    await telegram.sendMessage(chatId, `Stop failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
  }
}

async function changeCwd(chatId: string, rawPath: string): Promise<void> {
  if (bridgeState.activeTurnId) {
    await telegram.sendMessage(chatId, "Cannot change cwd while Codex is working. Stop the current turn or wait for it to finish first.");
    return;
  }

  let cwd: string;
  try {
    cwd = normalizeCwd(rawPath, currentCwd());
  } catch (error) {
    await telegram.sendMessage(chatId, `cwd change failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
    return;
  }

  persistState({ cwd, activeThreadId: undefined, activeTurnId: undefined });
  await telegram.sendMessage(chatId, `cwd set:\n${cwd}\n\nNext message will start a new Codex thread from this directory.`);
}

async function sendLogs(chatId: string): Promise<void> {
  if (!SHOW_PROGRESS) {
    await telegram.sendMessage(chatId, "Progress logging is disabled.");
    return;
  }
  const activeTurn = bridgeState.activeTurnId ? telegramTurns.get(bridgeState.activeTurnId) : undefined;
  const lines = activeTurn?.progressLines?.length ? activeTurn.progressLines : lastTurnReport?.progressLines;
  if (!lines?.length) {
    await telegram.sendMessage(chatId, "No progress logs yet.");
    return;
  }
  await telegram.sendMessage(chatId, `Recent progress:\n${lines.slice(-30).map((line) => `- ${line}`).join("\n")}`);
}

async function sendDiff(chatId: string, rawPath: string): Promise<void> {
  const path = rawPath.trim();
  const report = lastTurnReport;
  let diff = "";

  if (path && report?.fileDiffs.has(normalizeRelativePath(path))) {
    diff = report.fileDiffs.get(normalizeRelativePath(path)) ?? "";
  } else if (!path && report?.diff.trim()) {
    diff = report.diff;
  } else {
    const resolved = path ? resolveWorkspacePath(path) : undefined;
    if (resolved && !resolved.ok) {
      await telegram.sendMessage(chatId, resolved.error);
      return;
    }
    diff = gitDiff(path && resolved?.ok ? resolved.rel : undefined);
    if (!diff.trim() && resolved?.ok && isUntracked(resolved.rel)) {
      await telegram.sendMessage(chatId, `${resolved.rel} is untracked, so git has no tracked diff for it.\n\nUse:\n/file ${resolved.rel}`);
      return;
    }
  }

  if (!diff.trim()) {
    await telegram.sendMessage(chatId, path ? `No diff for ${path}.` : "No diff available.");
    return;
  }

  const clipped = clipWithNotice(diff.trim(), DIFF_MAX_CHARS, path ? `\n\n... truncated\nUse:\n/file ${normalizeRelativePath(path)}` : "\n\n... truncated");
  await telegram.sendMessage(chatId, clipped);
}

async function sendFile(chatId: string, rawArgs: string): Promise<void> {
  const { path, all } = parseFileArgs(rawArgs);
  if (!path) {
    await telegram.sendMessage(chatId, "Usage: /file <path>");
    return;
  }

  const resolved = resolveWorkspacePath(path);
  if (!resolved.ok) {
    await telegram.sendMessage(chatId, resolved.error);
    return;
  }
  const { abs, rel } = resolved;

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    await telegram.sendMessage(chatId, `File not found: ${rel}`);
    return;
  }
  if (!stat.isFile()) {
    await telegram.sendMessage(chatId, `Not a file: ${rel}`);
    return;
  }

  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (error) {
    await telegram.sendMessage(chatId, `Could not read ${rel}: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
    return;
  }

  if (content.includes("\u0000")) {
    await telegram.sendMessage(chatId, `${rel} looks like a binary file; not sending it as text.`);
    return;
  }

  const maxChars = all ? FILE_ALL_MAX_CHARS : FILE_PREVIEW_MAX_CHARS;
  const suffix = all
    ? "\n\n... truncated"
    : `\n\n... truncated\nUse:\n/file ${rel} --all`;
  const body = clipWithNotice(content, maxChars, suffix);
  await telegram.sendMessage(chatId, `File: ${rel}\n\n${body || "(empty)"}`);
}

function parseFileArgs(rawArgs: string): { path: string; all: boolean } {
  let rest = rawArgs.trim();
  const all = /\s+--all$/.test(rest);
  if (all) rest = rest.replace(/\s+--all$/, "").trim();
  return { path: rest, all };
}

function resolveWorkspacePath(rawPath: string): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const cwd = currentCwd();
  const input = rawPath.trim();
  if (!input) return { ok: false, error: "Path is required." };
  const abs = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `Refusing to read outside cwd:\n${cwd}` };
  }
  return { ok: true, abs, rel: normalizeRelativePath(rel) };
}

function gitDiff(path?: string): string {
  const args = path ? ["diff", "--", path] : ["diff"];
  return runGit(args);
}

function isUntracked(path: string): boolean {
  return runGit(["status", "--porcelain=v1", "--untracked-files=all", "--", path])
    .split("\n")
    .some((line) => line.startsWith("?? "));
}

function runGit(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: currentCwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function clipWithNotice(value: string, max: number, notice: string): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - notice.length))}${notice}`;
}

async function promptActiveTurnChoice(chatId: string, messageId: number, text: string, threadId: string, turnId: string): Promise<void> {
  prunePendingSteers();
  const key = randomBytes(3).toString("hex");
  pendingSteers.set(key, {
    chatId,
    text,
    threadId,
    turnId,
    createdAt: Date.now(),
  });

  await telegram.editMessageText(
    chatId,
    messageId,
    [
      "Codex is already working.",
      "",
      "Choose how to handle your new message:",
      clip(text, 600),
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Add to Turn", callback_data: `st:${key}:a` }],
          [
            { text: "Stop Current Turn", callback_data: `st:${key}:c` },
            { text: "Discard", callback_data: `st:${key}:d` },
          ],
        ],
      },
    },
  );
}

function prunePendingSteers(): void {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, pending] of pendingSteers) {
    if (pending.createdAt < cutoff) pendingSteers.delete(key);
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (message.chat.type !== "private") return;
  const senderId = String(message.from?.id ?? "");
  const chatId = String(message.chat.id);
  if (!senderId) return;

  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) return;

  if (text === "/start" || text === "/help") {
    await telegram.sendMessage(chatId, [
      "Codex Telegram Bridge",
      "",
      "Send any message to continue the active Codex app-server thread.",
      "/status shows the active thread.",
      "/new starts a fresh thread.",
      "/cancel stops the current Codex turn.",
      "/cwd <path> changes the project directory for the next thread.",
      "/diff [path] shows the last turn diff or current git diff.",
      "/file <path> sends a file preview.",
      "",
      "If you are not paired yet, send any message and approve the code locally:",
      "codex-tg pair <code>",
    ].join("\n"));
    return;
  }

  const gate = gatePrivateMessage(senderId, chatId);
  if (gate.action === "drop") return;
  if (gate.action === "pair") {
    const lead = gate.isResend ? "Still pending" : "Pairing required";
    await telegram.sendMessage(chatId, `${lead}. Run locally:\n\ncodex-tg pair ${gate.code}`);
    return;
  }

  if (gate.access.ackReaction) {
    void telegram.setReaction(chatId, message.message_id, gate.access.ackReaction).catch(() => {});
  }

  if (text === "/status") {
    await codex.connect().catch(() => undefined);
    await telegram.sendMessage(chatId, [
      `user: ${describeUser(message.from)}`,
      `appServer: ${CODEX_APP_SERVER_URL}`,
      `cwd: ${currentCwd()}`,
      `activeThreadId: ${bridgeState.activeThreadId ?? "-"}`,
      `activeTurnId: ${bridgeState.activeTurnId ?? "-"}`,
      `stateDir: ${defaultStateDir()}`,
    ].join("\n"));
    return;
  }

  if (text === "/cancel") {
    await cancelActiveTurn(chatId);
    return;
  }

  if (text === "/cwd") {
    await telegram.sendMessage(chatId, `cwd: ${currentCwd()}\n\nUse /cwd <path> to change it.`);
    return;
  }

  if (text.startsWith("/cwd ")) {
    await changeCwd(chatId, text.slice("/cwd ".length));
    return;
  }

  if (text === "/logs") {
    await sendLogs(chatId);
    return;
  }

  if (text === "/diff" || text.startsWith("/diff ")) {
    await sendDiff(chatId, text === "/diff" ? "" : text.slice("/diff ".length));
    return;
  }

  if (text === "/file" || text.startsWith("/file ")) {
    await sendFile(chatId, text === "/file" ? "" : text.slice("/file ".length));
    return;
  }

  if (text === "/new") {
    await codex.connect();
    const cwd = currentCwd();
    const response = await codex.request("thread/start", {
      cwd,
      ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = response.thread.id as string;
    persistState({ activeThreadId: threadId, activeTurnId: undefined, cwd });
    await telegram.sendMessage(chatId, `New Codex thread:\n${threadId}`);
    return;
  }

  if (text.startsWith("/thread ")) {
    const threadId = text.slice("/thread ".length).trim();
    if (!threadId) return;
    persistState({ activeThreadId: threadId, activeTurnId: undefined, cwd: currentCwd() });
    await codex.connect();
    await codex.ensureThread(bridgeState);
    await telegram.sendMessage(chatId, `Active thread set:\n${threadId}`);
    return;
  }

  await codex.connect();
  const threadId = await codex.ensureThread(bridgeState);

  if (bridgeState.activeTurnId) {
    const activeTurn = telegramTurns.get(bridgeState.activeTurnId);
    if (activeTurn?.cancelRequested) {
      await telegram.sendMessage(chatId, "Stop is still in progress. Try again in a moment.");
      return;
    }

    const choiceMessage = (await telegram.sendMessage(chatId, "Codex is already working."))[0];
    await promptActiveTurnChoice(chatId, choiceMessage.message_id, text, threadId, bridgeState.activeTurnId);
    return;
  }

  const status = await telegram.sendMessage(chatId, "Codex is working...");
  const statusMessage = status[0];
  void telegram.sendTyping(chatId).catch((error) => logTelegramError("typing indicator failed", error));

  const response = await codex.request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
    ...(CODEX_REASONING_EFFORT ? { effort: CODEX_REASONING_EFFORT } : {}),
  });
  const turnId = response.turn.id as string;
  persistState({ activeThreadId: threadId, activeTurnId: turnId });
  const turn: TelegramTurn = {
    turnId,
    threadId,
    chatId,
    statusMessageId: statusMessage.message_id,
    cwd: currentCwd(),
    buffer: "",
    progressLines: [],
    changedFiles: [],
    diff: "",
    fileDiffs: new Map(),
    cancelRequested: false,
    lastEditAt: 0,
  };
  telegramTurns.set(turnId, turn);
  startTypingIndicator(turn);
  await updateTurnMessage(turn, true);
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  if (!callback.data) return;
  const senderId = String(callback.from.id);
  if (!isAllowlisted(senderId)) {
    await telegram.answerCallbackQuery(callback.id, "Not authorized.").catch(() => {});
    return;
  }

  const steerMatch = /^st:([0-9a-f]{6}):(a|c|d)$/.exec(callback.data);
  if (steerMatch) {
    const [, key, action] = steerMatch;
    const pending = pendingSteers.get(key);
    if (!pending) {
      await telegram.answerCallbackQuery(callback.id, "This choice expired.").catch(() => {});
      return;
    }
    pendingSteers.delete(key);

    const message = callback.message;
    const messageChatId = message ? String(message.chat.id) : pending.chatId;
    const messageId = message?.message_id;

    if (action === "d") {
      await telegram.answerCallbackQuery(callback.id, "Discarded.").catch(() => {});
      if (messageId) await telegram.editMessageText(messageChatId, messageId, "Discarded.", removeReplyMarkupExtra()).catch(() => {});
      return;
    }

    if (action === "c") {
      await telegram.answerCallbackQuery(callback.id, "Stopping current turn...").catch(() => {});
      const turn = telegramTurns.get(pending.turnId);
      try {
        if (turn) await requestTurnInterrupt(turn);
        else await interruptTurn(pending.threadId, pending.turnId);
        if (messageId) {
          await telegram.editMessageText(messageChatId, messageId, "Stop requested for the current Codex turn. Send your message again after it stops.", removeReplyMarkupExtra()).catch(() => {});
        }
      } catch (error) {
        if (turn) {
          turn.cancelRequested = false;
          await updateTurnMessage(turn, true);
        }
        await telegram.sendMessage(pending.chatId, `Stop failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
      }
      return;
    }

    await telegram.answerCallbackQuery(callback.id, "Adding to current turn...").catch(() => {});
    try {
      await codex.connect();
      await codex.request("turn/steer", {
        threadId: pending.threadId,
        expectedTurnId: pending.turnId,
        input: [{ type: "text", text: pending.text, text_elements: [] }],
      });
      if (messageId) {
        await telegram.editMessageText(messageChatId, messageId, "Added your message to the current Codex turn.", removeReplyMarkupExtra()).catch(() => {});
      }
    } catch (error) {
      if (String((error as Error).message ?? error).includes("no active turn")) {
        persistState({ activeTurnId: undefined });
        if (messageId) {
          await telegram.editMessageText(messageChatId, messageId, "That Codex turn already finished. Send your message again to start a new turn.", removeReplyMarkupExtra()).catch(() => {});
        }
      } else {
        await telegram.sendMessage(pending.chatId, `Add failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
      }
    }
    return;
  }

  const cancelMatch = /^cx:(.+)$/.exec(callback.data);
  if (cancelMatch) {
    const turnId = cancelMatch[1];
    const turn = telegramTurns.get(turnId);
    if (!turn) {
      await telegram.answerCallbackQuery(callback.id, "Already finished.").catch(() => {});
      const message = callback.message;
      if (message) {
        await telegram.editMessageText(String(message.chat.id), message.message_id, message.text ?? "Done.", removeReplyMarkupExtra()).catch(() => {});
      }
      return;
    }

    if (turn.cancelRequested) {
      await telegram.answerCallbackQuery(callback.id, "Stop is already in progress.").catch(() => {});
      return;
    }

    await telegram.answerCallbackQuery(callback.id, "Stopping...").catch(() => {});
    try {
      await requestTurnInterrupt(turn);
    } catch (error) {
      turn.cancelRequested = false;
      await updateTurnMessage(turn, true);
      await telegram.sendMessage(turn.chatId, `Stop failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
    }
    return;
  }

  const match = /^ap:([0-9a-f]{6}):(a|d)$/.exec(callback.data);
  if (!match) return;
  const [, key, decision] = match;
  const entry = pendingApprovals.get(key);
  if (!entry) {
    await telegram.answerCallbackQuery(callback.id, "Approval expired.").catch(() => {});
    return;
  }
  pendingApprovals.delete(key);
  approveRequest(entry, decision === "a");
  await telegram.answerCallbackQuery(callback.id, decision === "a" ? "Allowed" : "Denied").catch(() => {});

  const message = callback.message;
  if (message) {
    const suffix = decision === "a" ? "\n\nAllowed from Telegram." : "\n\nDenied from Telegram.";
    await telegram.editMessageText(String(message.chat.id), message.message_id, `${entry.text}${suffix}`).catch(() => {});
  }
}

function checkApprovals(): void {
  try {
    mkdirSync(STATE.approvedDir, { recursive: true, mode: 0o700 });
    for (const senderId of readdirSync(STATE.approvedDir)) {
      const file = join(STATE.approvedDir, senderId);
      const chatId = readFileSync(file, "utf8").trim() || senderId;
      rmSync(file);
      void telegram.sendMessage(chatId, "Paired. Your Telegram messages now reach Codex.")
        .catch((error) => logTelegramError("pairing notification send failed", error));
    }
  } catch {
    // Best-effort notification only.
  }
}

async function checkLocalNotifications(): Promise<void> {
  let files: string[];
  try {
    mkdirSync(STATE.notificationsDir, { recursive: true, mode: 0o700 });
    files = readdirSync(STATE.notificationsDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, 10);
  } catch {
    return;
  }

  if (files.length === 0) return;
  const access = readAccess();
  if (access.allowFrom.length === 0) return;

  for (const name of files) {
    const file = join(STATE.notificationsDir, name);
    let note: LocalNotification;
    try {
      note = JSON.parse(readFileSync(file, "utf8")) as LocalNotification;
    } catch {
      rmSync(file, { force: true });
      continue;
    }

    const text = String(note.text ?? "").trim();
    if (!text) {
      rmSync(file, { force: true });
      continue;
    }

    for (const senderId of access.allowFrom) {
      let chatId = senderId;
      try {
        chatId = readFileSync(join(STATE.approvedDir, senderId), "utf8").trim() || senderId;
      } catch {
        // Private chat ids normally match sender ids; fall back to sender id.
      }
      await telegram.sendMessage(chatId, text);
    }
    rmSync(file, { force: true });
  }
}

let shuttingDown = false;
let approvalTimer: ReturnType<typeof setInterval> | undefined;
let notificationTimer: ReturnType<typeof setInterval> | undefined;
let checkingNotifications = false;

function configureTelegramHandlers(): void {
  bot.on("message", async (ctx) => {
    await handleMessage(ctx.message as TelegramMessage);
  });
  bot.on("callback_query:data", async (ctx) => {
    await handleCallback(ctx.callbackQuery as TelegramCallbackQuery);
  });
  bot.catch((error) => {
    logTelegramError("handler error", error.error);
  });
}

function startPeriodicChecks(): void {
  checkApprovals();
  runLocalNotificationCheck();
  approvalTimer = setInterval(checkApprovals, 5000);
  notificationTimer = setInterval(runLocalNotificationCheck, 5000);
  unrefTimer(approvalTimer);
  unrefTimer(notificationTimer);
}

function runLocalNotificationCheck(): void {
  if (checkingNotifications) return;
  checkingNotifications = true;
  void checkLocalNotifications()
    .catch((error) => logTelegramError("local notification check failed", error))
    .finally(() => {
      checkingNotifications = false;
    });
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

function stopPeriodicChecks(): void {
  if (approvalTimer) clearInterval(approvalTimer);
  if (notificationTimer) clearInterval(notificationTimer);
}

async function startTelegram(): Promise<void> {
  configureTelegramHandlers();
  startPeriodicChecks();

  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        allowed_updates: ["message", "callback_query"],
        timeout: 30,
        onStart: (info) => {
          attempt = 0;
          console.error(`codex telegram bridge: polling as @${info.username}`);
        },
      });
      return;
    } catch (error) {
      if (shuttingDown) return;
      const isConflict = error instanceof GrammyError && error.error_code === 409;
      if (isConflict && attempt >= 8) {
        logTelegramError("polling conflict", error);
        throw new Error("Telegram polling conflict persisted. Another bridge instance may be using this bot token.");
      }
      const delay = Math.min(1000 * attempt, 15000);
      const context = isConflict ? "polling conflict" : "polling failed";
      logTelegramError(`${context}; retrying in ${Math.round(delay / 1000)}s`, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPeriodicChecks();
  stopAllTypingIndicators();
  setTimeout(() => process.exit(0), 2000).unref();
  void Promise.resolve(bot.stop())
    .catch((error) => logTelegramError("stop failed", error))
    .finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  if (existsSync(STATE.bridgePidFile)) {
    try {
      const pid = readFileSync(STATE.bridgePidFile, "utf8").trim();
      if (pid === String(process.pid)) rmSync(STATE.bridgePidFile);
    } catch {
      // Ignore cleanup errors.
    }
  }
});

console.error(`codex telegram bridge: state=${STATE.stateDir}`);
console.error(`codex telegram bridge: app-server=${CODEX_APP_SERVER_URL}`);
console.error(`codex telegram bridge: cwd=${currentCwd()}`);
console.error(`codex telegram bridge: pid=${process.pid} telegram=grammy`);
void codex.connect().catch((error) => {
  console.error(`[${new Date().toISOString()}] Codex app-server initial connection failed: ${clip(oneLine(String((error as Error).message ?? error)), 500)}`);
});
await startTelegram();
