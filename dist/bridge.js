#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { chunkText, defaultStateDir, ensureDir, gatePrivateMessage, isAllowlisted, loadDotEnv, normalizeCwd, paths, readAccess, readBridgeState, writeBridgeState, } from "./common.js";
loadDotEnv();
const STATE = paths();
ensureDir(STATE.stateDir);
ensureDir(STATE.logsDir);
writeFileSync(STATE.bridgePidFile, String(process.pid), { mode: 0o600 });
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CODEX_APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:17345";
const CODEX_BRIDGE_CWD = process.env.CODEX_BRIDGE_CWD ?? process.cwd();
const CODEX_MODEL = process.env.CODEX_MODEL || undefined;
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || undefined;
const STREAM_EDITS = process.env.CODEX_TELEGRAM_STREAM_EDITS === "1";
const SHOW_PROGRESS = process.env.CODEX_TELEGRAM_PROGRESS !== "0";
const DIFF_MAX_CHARS = readPositiveInt(process.env.CODEX_TELEGRAM_DIFF_MAX_CHARS, 30000);
const FILE_PREVIEW_MAX_CHARS = readPositiveInt(process.env.CODEX_TELEGRAM_FILE_PREVIEW_MAX_CHARS, 12000);
const FILE_ALL_MAX_CHARS = readPositiveInt(process.env.CODEX_TELEGRAM_FILE_ALL_MAX_CHARS, 60000);
if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(`TELEGRAM_BOT_TOKEN is required. Set it in ${STATE.envFile}`);
}
class TelegramApi {
    token;
    constructor(token) {
        this.token = token;
    }
    async call(method, payload = {}) {
        let res;
        try {
            res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
            });
        }
        catch (error) {
            throw sanitizeTelegramError(error, this.token);
        }
        const body = await res.json().catch(() => undefined);
        if (!res.ok || !body?.ok) {
            throw new Error(`${method} failed: ${body?.description ?? res.statusText}`);
        }
        return body.result;
    }
    getUpdates(offset) {
        return this.call("getUpdates", {
            offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"],
        });
    }
    async sendMessage(chatId, text, extra = {}) {
        const sent = [];
        for (const chunk of chunkText(text || "(empty)")) {
            sent.push(await this.call("sendMessage", {
                chat_id: chatId,
                text: chunk,
                disable_web_page_preview: true,
                ...extra,
            }));
        }
        return sent;
    }
    editMessageText(chatId, messageId, text, extra = {}) {
        return this.call("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: text.slice(0, 4096) || "(empty)",
            disable_web_page_preview: true,
            ...extra,
        });
    }
    answerCallbackQuery(callbackQueryId, text) {
        return this.call("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            ...(text ? { text } : {}),
        });
    }
    setReaction(chatId, messageId, emoji) {
        return this.call("setMessageReaction", {
            chat_id: chatId,
            message_id: messageId,
            reaction: [{ type: "emoji", emoji }],
        });
    }
}
function sanitizeTelegramError(error, token = TELEGRAM_BOT_TOKEN) {
    const raw = error instanceof Error ? error.message : String(error);
    const redacted = token ? raw.split(token).join("<redacted-token>") : raw;
    return new Error(redacted);
}
function readPositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
class CodexClient {
    ws;
    nextId = 1;
    pending = new Map();
    connectPromise;
    resumedThreads = new Set();
    onNotification = () => { };
    onServerRequest = () => { };
    onClose = () => { };
    async connect() {
        if (this.ws?.readyState === WebSocket.OPEN)
            return;
        if (this.connectPromise)
            return this.connectPromise;
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
                for (const [, pending] of this.pending)
                    pending.reject(new Error("Codex app-server connection closed"));
                this.pending.clear();
                this.ws = undefined;
                this.connectPromise = undefined;
                this.resumedThreads.clear();
                this.onClose();
            });
        });
        return this.connectPromise;
    }
    request(method, params) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Codex app-server is not connected"));
        }
        const id = this.nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    notify(method, params) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({ method, params }));
    }
    respond(id, result) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({ id, result }));
    }
    respondError(id, message) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        ws.send(JSON.stringify({ id, error: { code: -32000, message } }));
    }
    async ensureThread(state) {
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
        const threadId = response.thread.id;
        writeBridgeState({ ...state, activeThreadId: threadId, cwd });
        this.resumedThreads.add(threadId);
        return threadId;
    }
    handleMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            this.pending.delete(message.id);
            if (message.error)
                pending.reject(new Error(message.error.message ?? "Codex request failed"));
            else
                pending.resolve(message.result);
            return;
        }
        if (message.id !== undefined && message.method) {
            this.onServerRequest(message);
            return;
        }
        if (message.method)
            this.onNotification(message);
    }
}
const telegram = new TelegramApi(TELEGRAM_BOT_TOKEN);
const codex = new CodexClient();
const telegramTurns = new Map();
const pendingApprovals = new Map();
const pendingSteers = new Map();
let lastTurnReport;
let bridgeState = readBridgeState();
if (!bridgeState.cwd)
    bridgeState.cwd = CODEX_BRIDGE_CWD;
function persistState(patch) {
    bridgeState = { ...bridgeState, ...patch };
    writeBridgeState(bridgeState);
}
function currentCwd() {
    return bridgeState.cwd ?? CODEX_BRIDGE_CWD;
}
function describeUser(user) {
    if (!user)
        return "unknown";
    return user.username ? `@${user.username}` : String(user.id);
}
async function setActiveThread(threadId, cwd) {
    persistState({ activeThreadId: threadId, cwd: cwd ?? bridgeState.cwd ?? CODEX_BRIDGE_CWD });
}
codex.onNotification = (message) => {
    const params = message.params ?? {};
    if (message.method === "thread/started" && params.thread?.id) {
        void setActiveThread(params.thread.id, params.thread.cwd);
    }
    if (message.method === "thread/status/changed" && params.threadId) {
        if (params.status?.type === "active")
            persistState({ activeThreadId: params.threadId });
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
        if (line)
            appendProgress(params.turnId, line);
    }
    if (message.method === "item/commandExecution/outputDelta") {
        const delta = String(params.delta ?? "").trim();
        if (delta)
            appendProgress(params.turnId, `Output: ${clip(oneLine(delta), 240)}`);
    }
    if (message.method === "item/fileChange/outputDelta") {
        const delta = String(params.delta ?? "").trim();
        if (delta)
            appendProgress(params.turnId, `Patch: ${clip(oneLine(delta), 240)}`);
    }
    if (message.method === "item/fileChange/patchUpdated") {
        addFileChanges(params.turnId, params.changes);
    }
    if (message.method === "item/mcpToolCall/progress") {
        if (params.message)
            appendProgress(params.turnId, String(params.message));
    }
    if (message.method === "item/agentMessage/delta") {
        const turn = telegramTurns.get(params.turnId);
        if (!turn)
            return;
        turn.buffer += params.delta ?? "";
        void maybeEditTurn(turn);
    }
    if (message.method === "item/completed") {
        const item = params.item;
        const turn = telegramTurns.get(params.turnId);
        if (!turn)
            return;
        if (item?.type === "agentMessage") {
            if (item.text && item.text.length > turn.buffer.length)
                turn.buffer = item.text;
            return;
        }
        if (item?.type === "fileChange")
            addFileChanges(params.turnId, item.changes);
        const line = describeItemCompleted(item);
        if (line)
            appendProgress(params.turnId, line, true);
    }
    if (message.method === "turn/completed") {
        if (bridgeState.activeTurnId === params.turn?.id)
            persistState({ activeTurnId: undefined });
        const turn = telegramTurns.get(params.turn?.id);
        if (!turn)
            return;
        telegramTurns.delete(params.turn.id);
        void finishTurn(turn, params.turn.status, params.turn.error);
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
        }).catch((error) => console.error(error));
    }
};
async function maybeEditTurn(turn) {
    if (!STREAM_EDITS)
        return;
    await updateTurnMessage(turn);
}
async function updateTurnMessage(turn, force = false) {
    const now = Date.now();
    if (!force && now - turn.lastEditAt < 1200)
        return;
    turn.lastEditAt = now;
    const preview = renderWorkingTurn(turn);
    await telegram.editMessageText(turn.chatId, turn.statusMessageId, preview, turnReplyMarkupExtra(turn)).catch(() => { });
}
function appendProgress(turnId, line, force = false) {
    if (!SHOW_PROGRESS || !turnId || !line)
        return;
    const turn = telegramTurns.get(turnId);
    if (!turn)
        return;
    turn.progressLines ??= [];
    const normalized = line.trim();
    if (!normalized)
        return;
    if (turn.progressLines.at(-1) === normalized)
        return;
    turn.progressLines.push(normalized);
    if (turn.progressLines.length > 30)
        turn.progressLines.splice(0, turn.progressLines.length - 30);
    void updateTurnMessage(turn, force);
}
function updateTurnDiff(turnId, diff) {
    if (!turnId)
        return;
    const turn = telegramTurns.get(turnId);
    if (!turn)
        return;
    turn.diff = diff;
    const parsed = parseUnifiedDiff(diff);
    mergeChangedFiles(turn, parsed.files);
    for (const [path, fileDiff] of parsed.fileDiffs)
        turn.fileDiffs.set(path, fileDiff);
}
function addFileChanges(turnId, changes) {
    if (!turnId || !Array.isArray(changes))
        return;
    const turn = telegramTurns.get(turnId);
    if (!turn)
        return;
    const files = [];
    for (const change of changes) {
        const path = normalizeRelativePath(String(change?.path ?? ""));
        if (!path)
            continue;
        files.push(path);
        const diff = String(change?.diff ?? "");
        if (diff)
            turn.fileDiffs.set(path, diff);
    }
    mergeChangedFiles(turn, files);
}
function mergeChangedFiles(turn, files) {
    const seen = new Set(turn.changedFiles);
    for (const file of files) {
        const normalized = normalizeRelativePath(file);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        turn.changedFiles.push(normalized);
    }
}
async function finishTurn(turn, status, error) {
    lastTurnReport = buildTurnReport(turn);
    if (status !== "completed") {
        const message = status === "interrupted" && turn.cancelRequested
            ? "Cancelled."
            : error?.message ? `${status}: ${error.message}` : `Turn ${status}`;
        const progress = renderProgress(turn);
        await telegram.editMessageText(turn.chatId, turn.statusMessageId, progress ? `${progress}\n\n${message}` : message, removeReplyMarkupExtra()).catch(() => { });
        return;
    }
    if (!turn.buffer.trim()) {
        const finalText = renderFinalTurn(turn);
        await telegram.editMessageText(turn.chatId, turn.statusMessageId, finalText, removeReplyMarkupExtra()).catch(() => { });
        return;
    }
    const chunks = chunkText(turn.buffer);
    const finalText = renderFinalTurn(turn);
    if (finalText.length <= 3900) {
        await telegram.editMessageText(turn.chatId, turn.statusMessageId, finalText, removeReplyMarkupExtra()).catch(async () => {
            await telegram.editMessageText(turn.chatId, turn.statusMessageId, "Done.", removeReplyMarkupExtra()).catch(() => { });
            await telegram.sendMessage(turn.chatId, finalText);
        });
        return;
    }
    const progress = renderProgress(turn);
    const changes = renderChangeSummary(buildTurnReport(turn));
    await telegram.editMessageText(turn.chatId, turn.statusMessageId, [progress, changes, "Answer is long; sending it in parts."].filter(Boolean).join("\n\n"), removeReplyMarkupExtra()).catch(() => { });
    for (const chunk of chunks)
        await telegram.sendMessage(turn.chatId, chunk);
}
function renderWorkingTurn(turn) {
    const progress = renderProgress(turn);
    const parts = [
        turn.cancelRequested ? "Cancelling Codex turn..." : "Codex is working...",
        `cwd: ${basename(turn.cwd) || turn.cwd}`,
        `thread: ${shortId(turn.threadId)}`,
        `turn: ${shortId(turn.turnId)}`,
    ];
    if (progress)
        parts.push("", progress);
    if (STREAM_EDITS && turn.buffer.trim()) {
        parts.push("", "Draft:", clip(turn.buffer.trim(), 1200));
    }
    return clip(parts.join("\n"), 3900);
}
function turnReplyMarkupExtra(turn) {
    return {
        reply_markup: turn.cancelRequested
            ? { inline_keyboard: [] }
            : { inline_keyboard: [[{ text: "Cancel", callback_data: `cx:${turn.turnId}` }]] },
    };
}
function removeReplyMarkupExtra() {
    return { reply_markup: { inline_keyboard: [] } };
}
function renderFinalTurn(turn) {
    const answer = turn.buffer.trim() || "Done.";
    const progress = renderProgress(turn);
    const changes = renderChangeSummary(buildTurnReport(turn));
    const parts = [];
    if (progress)
        parts.push(progress);
    if (changes)
        parts.push(changes);
    parts.push(`Answer:\n${answer}`);
    return parts.join("\n\n");
}
function renderProgress(turn) {
    const progressLines = turn.progressLines ?? [];
    if (!progressLines.length)
        return "";
    const lines = progressLines.slice(-14).map((line) => `- ${line}`);
    return `Progress:\n${lines.join("\n")}`;
}
function buildTurnReport(turn) {
    const parsed = turn.diff ? parseUnifiedDiff(turn.diff) : { files: [], fileDiffs: new Map() };
    const changedFiles = uniqueStrings([...turn.changedFiles, ...parsed.files]);
    const fileDiffs = new Map(parsed.fileDiffs);
    for (const [path, diff] of turn.fileDiffs)
        fileDiffs.set(path, diff);
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
function renderChangeSummary(report) {
    const files = report.changedFiles;
    if (!files.length && !report.diff.trim())
        return "";
    const parts = [];
    if (files.length) {
        const shown = files.slice(0, 10).map((file) => `- ${file}`);
        if (files.length > shown.length)
            shown.push(`- ... ${files.length - shown.length} more`);
        parts.push(`Workspace changes:\n${shown.join("\n")}`);
    }
    const preview = renderDiffPreview(report, 70, 1600);
    if (preview)
        parts.push(preview);
    return parts.join("\n\n");
}
function renderDiffPreview(report, maxLines, maxChars) {
    const diff = report.diff.trim();
    if (!diff)
        return "";
    const lines = diff.split("\n");
    let clippedLines = lines.slice(0, maxLines);
    let body = clippedLines.join("\n");
    let truncated = lines.length > maxLines;
    if (body.length > maxChars) {
        body = body.slice(0, maxChars);
        truncated = true;
    }
    const parts = [`Diff preview:\n${body}`];
    if (truncated) {
        const path = report.changedFiles[0];
        parts.push("... truncated");
        if (path) {
            parts.push(`Use:\n/diff ${path}\n/file ${path}`);
        }
        else {
            parts.push("Use /diff to view the full diff.");
        }
    }
    return parts.join("\n\n");
}
function parseUnifiedDiff(diff) {
    const files = [];
    const fileDiffs = new Map();
    const lines = diff.split("\n");
    let currentPath = "";
    let currentLines = [];
    function flush() {
        if (!currentPath)
            return;
        const normalized = normalizeRelativePath(currentPath);
        if (!normalized)
            return;
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
        if (currentPath)
            currentLines.push(line);
    }
    flush();
    if (!files.length) {
        for (const line of lines) {
            const match = /^\+\+\+ b\/(.+)$/.exec(line);
            if (match)
                files.push(normalizeRelativePath(match[1]));
        }
    }
    return { files: uniqueStrings(files), fileDiffs };
}
function normalizeRelativePath(path) {
    let normalized = path.trim();
    if (!normalized || normalized === "/dev/null")
        return "";
    normalized = normalized.replace(/\\/g, "/");
    if (normalized.startsWith("./"))
        normalized = normalized.slice(2);
    return normalized;
}
function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = normalizeRelativePath(value);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}
function describeItemStarted(item) {
    if (!item)
        return undefined;
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
function describeItemCompleted(item) {
    if (!item)
        return undefined;
    switch (item.type) {
        case "commandExecution": {
            const lines = [`Ran: ${shortCommand(item.command)}`];
            if (typeof item.exitCode === "number" && item.exitCode !== 0)
                lines.push(`exit ${item.exitCode}`);
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
function oneLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
function shortCommand(value) {
    return clip(oneLine(value ?? ""), 180);
}
function clip(value, max) {
    return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}
function shortId(value) {
    return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}
function formatApprovalRequest(request, key) {
    const method = request.method;
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
function approveRequest(entry, allow) {
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
async function requestTurnInterrupt(turn) {
    turn.cancelRequested = true;
    await updateTurnMessage(turn, true);
    await interruptTurn(turn.threadId, turn.turnId);
}
async function interruptTurn(threadId, turnId) {
    await codex.connect();
    await codex.request("turn/interrupt", {
        threadId,
        turnId,
    });
}
async function cancelActiveTurn(chatId) {
    const turn = bridgeState.activeTurnId ? telegramTurns.get(bridgeState.activeTurnId) : undefined;
    if (!turn) {
        if (bridgeState.activeThreadId && bridgeState.activeTurnId) {
            try {
                await interruptTurn(bridgeState.activeThreadId, bridgeState.activeTurnId);
                await telegram.sendMessage(chatId, "Cancellation requested.");
            }
            catch (error) {
                await telegram.sendMessage(chatId, `Cancel failed: ${clip(oneLine(String(error.message ?? error)), 500)}`);
            }
            return;
        }
        await telegram.sendMessage(chatId, "No active Codex turn to cancel.");
        return;
    }
    if (turn.cancelRequested) {
        await telegram.sendMessage(chatId, "Cancellation is already in progress.");
        return;
    }
    try {
        await requestTurnInterrupt(turn);
        await telegram.sendMessage(chatId, "Cancellation requested.");
    }
    catch (error) {
        turn.cancelRequested = false;
        await updateTurnMessage(turn, true);
        await telegram.sendMessage(chatId, `Cancel failed: ${clip(oneLine(String(error.message ?? error)), 500)}`);
    }
}
async function changeCwd(chatId, rawPath) {
    if (bridgeState.activeTurnId) {
        await telegram.sendMessage(chatId, "Cannot change cwd while Codex is working. Cancel or wait for the turn to finish first.");
        return;
    }
    let cwd;
    try {
        cwd = normalizeCwd(rawPath, currentCwd());
    }
    catch (error) {
        await telegram.sendMessage(chatId, `cwd change failed: ${clip(oneLine(String(error.message ?? error)), 500)}`);
        return;
    }
    persistState({ cwd, activeThreadId: undefined, activeTurnId: undefined });
    await telegram.sendMessage(chatId, `cwd set:\n${cwd}\n\nNext message will start a new Codex thread from this directory.`);
}
async function sendLogs(chatId) {
    const activeTurn = bridgeState.activeTurnId ? telegramTurns.get(bridgeState.activeTurnId) : undefined;
    const lines = activeTurn?.progressLines?.length ? activeTurn.progressLines : lastTurnReport?.progressLines;
    if (!lines?.length) {
        await telegram.sendMessage(chatId, "No progress logs yet.");
        return;
    }
    await telegram.sendMessage(chatId, `Recent progress:\n${lines.slice(-30).map((line) => `- ${line}`).join("\n")}`);
}
async function sendDiff(chatId, rawPath) {
    const path = rawPath.trim();
    const report = lastTurnReport;
    let diff = "";
    if (path && report?.fileDiffs.has(normalizeRelativePath(path))) {
        diff = report.fileDiffs.get(normalizeRelativePath(path)) ?? "";
    }
    else if (!path && report?.diff.trim()) {
        diff = report.diff;
    }
    else {
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
async function sendFile(chatId, rawArgs) {
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
    }
    catch {
        await telegram.sendMessage(chatId, `File not found: ${rel}`);
        return;
    }
    if (!stat.isFile()) {
        await telegram.sendMessage(chatId, `Not a file: ${rel}`);
        return;
    }
    let content;
    try {
        content = readFileSync(abs, "utf8");
    }
    catch (error) {
        await telegram.sendMessage(chatId, `Could not read ${rel}: ${clip(oneLine(String(error.message ?? error)), 500)}`);
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
function parseFileArgs(rawArgs) {
    let rest = rawArgs.trim();
    const all = /\s+--all$/.test(rest);
    if (all)
        rest = rest.replace(/\s+--all$/, "").trim();
    return { path: rest, all };
}
function resolveWorkspacePath(rawPath) {
    const cwd = currentCwd();
    const input = rawPath.trim();
    if (!input)
        return { ok: false, error: "Path is required." };
    const abs = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
    const rel = relative(cwd, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        return { ok: false, error: `Refusing to read outside cwd:\n${cwd}` };
    }
    return { ok: true, abs, rel: normalizeRelativePath(rel) };
}
function gitDiff(path) {
    const args = path ? ["diff", "--", path] : ["diff"];
    return runGit(args);
}
function isUntracked(path) {
    return runGit(["status", "--porcelain=v1", "--untracked-files=all", "--", path])
        .split("\n")
        .some((line) => line.startsWith("?? "));
}
function runGit(args) {
    try {
        return execFileSync("git", args, {
            cwd: currentCwd(),
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
        });
    }
    catch {
        return "";
    }
}
function clipWithNotice(value, max, notice) {
    if (value.length <= max)
        return value;
    return `${value.slice(0, Math.max(0, max - notice.length))}${notice}`;
}
async function promptActiveTurnChoice(chatId, messageId, text, threadId, turnId) {
    prunePendingSteers();
    const key = randomBytes(3).toString("hex");
    pendingSteers.set(key, {
        chatId,
        text,
        threadId,
        turnId,
        createdAt: Date.now(),
    });
    await telegram.editMessageText(chatId, messageId, [
        "Codex is already working.",
        "",
        "Choose how to handle your new message:",
        clip(text, 600),
    ].join("\n"), {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Add to Turn", callback_data: `st:${key}:a` }],
                [
                    { text: "Cancel Current", callback_data: `st:${key}:c` },
                    { text: "Discard", callback_data: `st:${key}:d` },
                ],
            ],
        },
    });
}
function prunePendingSteers() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, pending] of pendingSteers) {
        if (pending.createdAt < cutoff)
            pendingSteers.delete(key);
    }
}
async function handleMessage(message) {
    if (message.chat.type !== "private")
        return;
    const senderId = String(message.from?.id ?? "");
    const chatId = String(message.chat.id);
    if (!senderId)
        return;
    const text = (message.text ?? message.caption ?? "").trim();
    if (!text)
        return;
    if (text === "/start" || text === "/help") {
        await telegram.sendMessage(chatId, [
            "Codex Telegram Bridge",
            "",
            "Send any message to continue the active Codex app-server thread.",
            "/status shows the active thread.",
            "/new starts a fresh thread.",
            "/cancel interrupts the active turn.",
            "/cwd <path> changes the project directory for the next thread.",
            "/logs shows recent progress.",
            "/diff [path] shows the last turn diff or current git diff.",
            "/file <path> sends a file preview.",
            "",
            "If you are not paired yet, send any message and approve the code locally:",
            "codex-tg pair <code>",
        ].join("\n"));
        return;
    }
    const gate = gatePrivateMessage(senderId, chatId);
    if (gate.action === "drop")
        return;
    if (gate.action === "pair") {
        const lead = gate.isResend ? "Still pending" : "Pairing required";
        await telegram.sendMessage(chatId, `${lead}. Run locally:\n\ncodex-tg pair ${gate.code}`);
        return;
    }
    if (gate.access.ackReaction) {
        void telegram.setReaction(chatId, message.message_id, gate.access.ackReaction).catch(() => { });
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
        const threadId = response.thread.id;
        persistState({ activeThreadId: threadId, activeTurnId: undefined, cwd });
        await telegram.sendMessage(chatId, `New Codex thread:\n${threadId}`);
        return;
    }
    if (text.startsWith("/thread ")) {
        const threadId = text.slice("/thread ".length).trim();
        if (!threadId)
            return;
        persistState({ activeThreadId: threadId, activeTurnId: undefined, cwd: currentCwd() });
        await codex.connect();
        await codex.ensureThread(bridgeState);
        await telegram.sendMessage(chatId, `Active thread set:\n${threadId}`);
        return;
    }
    const status = await telegram.sendMessage(chatId, "Codex is working...");
    const statusMessage = status[0];
    await codex.connect();
    const threadId = await codex.ensureThread(bridgeState);
    if (bridgeState.activeTurnId) {
        const activeTurn = telegramTurns.get(bridgeState.activeTurnId);
        if (activeTurn?.cancelRequested) {
            await telegram.editMessageText(chatId, statusMessage.message_id, "Cancellation is still in progress. Try again in a moment.");
            return;
        }
        await promptActiveTurnChoice(chatId, statusMessage.message_id, text, threadId, bridgeState.activeTurnId);
        return;
    }
    const response = await codex.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        ...(CODEX_MODEL ? { model: CODEX_MODEL } : {}),
        ...(CODEX_REASONING_EFFORT ? { effort: CODEX_REASONING_EFFORT } : {}),
    });
    const turnId = response.turn.id;
    persistState({ activeThreadId: threadId, activeTurnId: turnId });
    const turn = {
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
    await updateTurnMessage(turn, true);
}
async function handleCallback(update) {
    const callback = update.callback_query;
    if (!callback?.data)
        return;
    const senderId = String(callback.from.id);
    if (!isAllowlisted(senderId)) {
        await telegram.answerCallbackQuery(callback.id, "Not authorized.").catch(() => { });
        return;
    }
    const steerMatch = /^st:([0-9a-f]{6}):(a|c|d)$/.exec(callback.data);
    if (steerMatch) {
        const [, key, action] = steerMatch;
        const pending = pendingSteers.get(key);
        if (!pending) {
            await telegram.answerCallbackQuery(callback.id, "This choice expired.").catch(() => { });
            return;
        }
        pendingSteers.delete(key);
        const message = callback.message;
        const messageChatId = message ? String(message.chat.id) : pending.chatId;
        const messageId = message?.message_id;
        if (action === "d") {
            await telegram.answerCallbackQuery(callback.id, "Discarded.").catch(() => { });
            if (messageId)
                await telegram.editMessageText(messageChatId, messageId, "Discarded.", removeReplyMarkupExtra()).catch(() => { });
            return;
        }
        if (action === "c") {
            await telegram.answerCallbackQuery(callback.id, "Cancelling current turn...").catch(() => { });
            const turn = telegramTurns.get(pending.turnId);
            try {
                if (turn)
                    await requestTurnInterrupt(turn);
                else
                    await interruptTurn(pending.threadId, pending.turnId);
                if (messageId) {
                    await telegram.editMessageText(messageChatId, messageId, "Cancellation requested. Send your message again after the current turn stops.", removeReplyMarkupExtra()).catch(() => { });
                }
            }
            catch (error) {
                if (turn) {
                    turn.cancelRequested = false;
                    await updateTurnMessage(turn, true);
                }
                await telegram.sendMessage(pending.chatId, `Cancel failed: ${clip(oneLine(String(error.message ?? error)), 500)}`);
            }
            return;
        }
        await telegram.answerCallbackQuery(callback.id, "Adding to current turn...").catch(() => { });
        try {
            await codex.connect();
            await codex.request("turn/steer", {
                threadId: pending.threadId,
                expectedTurnId: pending.turnId,
                input: [{ type: "text", text: pending.text, text_elements: [] }],
            });
            if (messageId) {
                await telegram.editMessageText(messageChatId, messageId, "Added your message to the current Codex turn.", removeReplyMarkupExtra()).catch(() => { });
            }
        }
        catch (error) {
            if (String(error.message ?? error).includes("no active turn")) {
                persistState({ activeTurnId: undefined });
                if (messageId) {
                    await telegram.editMessageText(messageChatId, messageId, "That Codex turn already finished. Send your message again to start a new turn.", removeReplyMarkupExtra()).catch(() => { });
                }
            }
            else {
                await telegram.sendMessage(pending.chatId, `Add failed: ${clip(oneLine(String(error.message ?? error)), 500)}`);
            }
        }
        return;
    }
    const cancelMatch = /^cx:(.+)$/.exec(callback.data);
    if (cancelMatch) {
        const turnId = cancelMatch[1];
        const turn = telegramTurns.get(turnId);
        if (!turn) {
            await telegram.answerCallbackQuery(callback.id, "Already finished.").catch(() => { });
            const message = callback.message;
            if (message) {
                await telegram.editMessageText(String(message.chat.id), message.message_id, message.text ?? "Done.", removeReplyMarkupExtra()).catch(() => { });
            }
            return;
        }
        if (turn.cancelRequested) {
            await telegram.answerCallbackQuery(callback.id, "Cancellation is already in progress.").catch(() => { });
            return;
        }
        await telegram.answerCallbackQuery(callback.id, "Cancelling...").catch(() => { });
        try {
            await requestTurnInterrupt(turn);
        }
        catch (error) {
            turn.cancelRequested = false;
            await updateTurnMessage(turn, true);
            await telegram.sendMessage(turn.chatId, `Cancel failed: ${clip(oneLine(String(error.message ?? error)), 500)}`);
        }
        return;
    }
    const match = /^ap:([0-9a-f]{6}):(a|d)$/.exec(callback.data);
    if (!match)
        return;
    const [, key, decision] = match;
    const entry = pendingApprovals.get(key);
    if (!entry) {
        await telegram.answerCallbackQuery(callback.id, "Approval expired.").catch(() => { });
        return;
    }
    pendingApprovals.delete(key);
    approveRequest(entry, decision === "a");
    await telegram.answerCallbackQuery(callback.id, decision === "a" ? "Allowed" : "Denied").catch(() => { });
    const message = callback.message;
    if (message) {
        const suffix = decision === "a" ? "\n\nAllowed from Telegram." : "\n\nDenied from Telegram.";
        await telegram.editMessageText(String(message.chat.id), message.message_id, `${entry.text}${suffix}`).catch(() => { });
    }
}
function checkApprovals() {
    try {
        mkdirSync(STATE.approvedDir, { recursive: true, mode: 0o700 });
        for (const senderId of readdirSync(STATE.approvedDir)) {
            const file = join(STATE.approvedDir, senderId);
            const chatId = readFileSync(file, "utf8").trim() || senderId;
            rmSync(file);
            void telegram.sendMessage(chatId, "Paired. Your Telegram messages now reach Codex.").catch(() => { });
        }
    }
    catch {
        // Best-effort notification only.
    }
}
async function pollTelegram() {
    let offset = bridgeState.telegramOffset;
    for (;;) {
        checkApprovals();
        try {
            const updates = await telegram.getUpdates(offset);
            for (const update of updates) {
                offset = update.update_id + 1;
                persistState({ telegramOffset: offset });
                if (update.callback_query)
                    await handleCallback(update);
                if (update.message)
                    await handleMessage(update.message);
            }
        }
        catch (error) {
            console.error(sanitizeTelegramError(error));
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
}
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => {
    if (existsSync(STATE.bridgePidFile)) {
        try {
            const pid = readFileSync(STATE.bridgePidFile, "utf8").trim();
            if (pid === String(process.pid))
                rmSync(STATE.bridgePidFile);
        }
        catch {
            // Ignore cleanup errors.
        }
    }
});
console.error(`codex telegram bridge: state=${STATE.stateDir}`);
console.error(`codex telegram bridge: app-server=${CODEX_APP_SERVER_URL}`);
console.error(`codex telegram bridge: cwd=${CODEX_BRIDGE_CWD}`);
await codex.connect();
await pollTelegram();
