#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultAccess,
  loadDotEnv,
  normalizeCwd,
  paths,
  pruneExpired,
  readAccess,
  readBridgeState,
  writeAccess,
  writeBridgeState,
} from "./common.js";

loadDotEnv();

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const quiet = args.includes("--quiet");
const ifMissing = args.includes("--if-missing");

function save(access = readAccess()): void {
  writeAccess(access);
}

function status(): void {
  const access = readAccess();
  const bridgeState = readBridgeState();
  if (pruneExpired(access)) save(access);
  console.log(`state: ${paths().stateDir}`);
  console.log(`cwd: ${bridgeState.cwd ?? "-"}`);
  console.log(`activeThreadId: ${bridgeState.activeThreadId ?? "-"}`);
  console.log(`activeTurnId: ${bridgeState.activeTurnId ?? "-"}`);
  console.log(`dmPolicy: ${access.dmPolicy}`);
  console.log(`allowFrom (${access.allowFrom.length}): ${access.allowFrom.join(", ") || "-"}`);
  const pending = Object.entries(access.pending);
  console.log(`pending (${pending.length}):`);
  for (const [code, entry] of pending) {
    const ageSeconds = Math.round((Date.now() - entry.createdAt) / 1000);
    console.log(`  ${code} sender=${entry.senderId} chat=${entry.chatId} age=${ageSeconds}s`);
  }
}

switch (command) {
  case "status": {
    status();
    break;
  }
  case "cwd": {
    const state = readBridgeState();
    const rawPath = args.slice(1).join(" ");
    if (!rawPath) {
      console.log(state.cwd ?? process.cwd());
      break;
    }
    const cwd = normalizeCwd(rawPath, state.cwd ?? process.cwd());
    writeBridgeState({ ...state, cwd, activeThreadId: undefined, activeTurnId: undefined });
    console.log(`cwd=${cwd}`);
    console.log("active thread cleared; the next Telegram message will start a new Codex thread from this directory.");
    break;
  }
  case "notify": {
    const text = args.slice(1).join(" ").trim();
    if (!text) throw new Error("usage: codex-tg notify <message>");
    const state = readBridgeState();
    const dir = paths().notificationsDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${process.pid}-${randomBytes(3).toString("hex")}`;
    const file = join(dir, `${id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({
      id,
      text,
      cwd: state.cwd ?? process.cwd(),
      createdAt: new Date().toISOString(),
      source: "codex-tg notify",
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    console.log(`queued notification ${id}`);
    console.log("the running Telegram bridge will deliver it to allowlisted chats");
    break;
  }
  case "install-skill": {
    const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
    if (!codexHome || codexHome === ".codex") throw new Error("HOME is required to install the Codex skill");
    const source = join(packageRoot, "skills", "codex-telegram-notify", "SKILL.md");
    const targetDir = join(codexHome, "skills", "codex-telegram-notify");
    const target = join(targetDir, "SKILL.md");
    if (ifMissing && existsSync(target)) break;
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    if (!quiet) {
      console.log(`installed Codex skill: ${target}`);
      console.log("restart Codex sessions to make the new skill discoverable");
    }
    break;
  }
  case "pair": {
    const code = args[1];
    if (!code) throw new Error("usage: codex-tg pair <code>");
    const access = readAccess();
    if (pruneExpired(access)) save(access);
    const pending = access.pending[code];
    if (!pending) throw new Error(`pairing code not found: ${code}`);
    if (pending.expiresAt < Date.now()) throw new Error(`pairing code expired: ${code}`);
    if (!access.allowFrom.includes(pending.senderId)) access.allowFrom.push(pending.senderId);
    delete access.pending[code];
    writeAccess(access);
    mkdirSync(paths().approvedDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(paths().approvedDir, pending.senderId), pending.chatId, { mode: 0o600 });
    console.log(`approved sender ${pending.senderId}`);
    break;
  }
  case "deny": {
    const code = args[1];
    if (!code) throw new Error("usage: codex-tg deny <code>");
    const access = readAccess();
    delete access.pending[code];
    writeAccess(access);
    console.log(`denied ${code}`);
    break;
  }
  case "allow": {
    const senderId = args[1];
    if (!senderId) throw new Error("usage: codex-tg allow <senderId>");
    const access = readAccess();
    if (!access.allowFrom.includes(senderId)) access.allowFrom.push(senderId);
    writeAccess(access);
    console.log(`allowed ${senderId}`);
    break;
  }
  case "remove": {
    const senderId = args[1];
    if (!senderId) throw new Error("usage: codex-tg remove <senderId>");
    const access = readAccess();
    access.allowFrom = access.allowFrom.filter((id) => id !== senderId);
    writeAccess(access);
    console.log(`removed ${senderId}`);
    break;
  }
  case "policy": {
    const policy = args[1] as "pairing" | "allowlist" | "disabled" | undefined;
    if (!policy || !["pairing", "allowlist", "disabled"].includes(policy)) {
      throw new Error("usage: codex-tg policy <pairing|allowlist|disabled>");
    }
    const access = readAccess();
    access.dmPolicy = policy;
    writeAccess(access);
    console.log(`dmPolicy=${policy}`);
    break;
  }
  case "init": {
    writeAccess(defaultAccess());
    console.log(`initialized ${paths().accessFile}`);
    break;
  }
  default:
    throw new Error(`unknown command: ${command}`);
}
