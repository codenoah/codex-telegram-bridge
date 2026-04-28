import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
export function defaultStateDir() {
    return process.env.CODEX_TELEGRAM_STATE_DIR
        ?? process.env.TELEGRAM_STATE_DIR
        ?? join(homedir(), ".codex", "telegram-bridge");
}
export function paths(stateDir = defaultStateDir()) {
    return {
        stateDir,
        envFile: join(stateDir, ".env"),
        accessFile: join(stateDir, "access.json"),
        bridgeStateFile: join(stateDir, "state.json"),
        approvedDir: join(stateDir, "approved"),
        logsDir: join(stateDir, "logs"),
        bridgePidFile: join(stateDir, "bridge.pid"),
        appServerPidFile: join(stateDir, "app-server.pid"),
    };
}
export function loadDotEnv(file = paths().envFile) {
    try {
        chmodSync(file, 0o600);
        for (const line of readFileSync(file, "utf8").split("\n")) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
            if (!match)
                continue;
            const [, key, rawValue] = match;
            if (process.env[key] === undefined)
                process.env[key] = rawValue;
        }
    }
    catch {
        // Missing .env is fine; callers also accept real environment variables.
    }
}
export function ensureDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
}
export function readJson(file, fallback) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return fallback;
        try {
            renameSync(file, `${file}.corrupt-${Date.now()}`);
        }
        catch {
            // If quarantine fails, still recover with defaults.
        }
        return fallback;
    }
}
export function writeJson(file, value) {
    ensureDir(dirname(file));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
}
export function defaultAccess() {
    return {
        dmPolicy: "pairing",
        allowFrom: [],
        pending: {},
    };
}
export function readAccess() {
    const access = readJson(paths().accessFile, defaultAccess());
    return {
        dmPolicy: access.dmPolicy ?? "pairing",
        allowFrom: access.allowFrom ?? [],
        pending: access.pending ?? {},
        ackReaction: access.ackReaction,
    };
}
export function writeAccess(access) {
    writeJson(paths().accessFile, access);
}
export function readBridgeState() {
    return readJson(paths().bridgeStateFile, {});
}
export function writeBridgeState(state) {
    writeJson(paths().bridgeStateFile, {
        ...state,
        updatedAt: new Date().toISOString(),
    });
}
export function normalizeCwd(input, base = process.cwd()) {
    const trimmed = input.trim();
    if (!trimmed)
        throw new Error("cwd path is required");
    const expanded = trimmed === "~"
        ? homedir()
        : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
    const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
    let stat;
    try {
        stat = statSync(absolute);
    }
    catch {
        throw new Error(`cwd does not exist: ${absolute}`);
    }
    if (!stat.isDirectory())
        throw new Error(`cwd is not a directory: ${absolute}`);
    return realpathSync(absolute);
}
export function pruneExpired(access) {
    const now = Date.now();
    let changed = false;
    for (const [code, pending] of Object.entries(access.pending)) {
        if (pending.expiresAt < now) {
            delete access.pending[code];
            changed = true;
        }
    }
    return changed;
}
export function gatePrivateMessage(senderId, chatId) {
    const access = readAccess();
    if (pruneExpired(access))
        writeAccess(access);
    if (access.dmPolicy === "disabled")
        return { action: "drop" };
    if (access.allowFrom.includes(senderId))
        return { action: "deliver", access };
    if (access.dmPolicy === "allowlist")
        return { action: "drop" };
    for (const [code, pending] of Object.entries(access.pending)) {
        if (pending.senderId !== senderId)
            continue;
        if ((pending.replies ?? 1) >= 2)
            return { action: "drop" };
        pending.replies = (pending.replies ?? 1) + 1;
        writeAccess(access);
        return { action: "pair", code, isResend: true };
    }
    if (Object.keys(access.pending).length >= 3)
        return { action: "drop" };
    const code = randomBytes(3).toString("hex");
    const now = Date.now();
    access.pending[code] = {
        senderId,
        chatId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
        replies: 1,
    };
    writeAccess(access);
    return { action: "pair", code, isResend: false };
}
export function isAllowlisted(senderId) {
    return readAccess().allowFrom.includes(senderId);
}
export function chunkText(text, limit = 3900) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n\n", limit);
        if (cut < Math.floor(limit * 0.5))
            cut = rest.lastIndexOf("\n", limit);
        if (cut < Math.floor(limit * 0.5))
            cut = limit;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    if (rest)
        chunks.push(rest);
    return chunks;
}
