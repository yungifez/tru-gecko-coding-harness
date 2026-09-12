import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const configPath = path.join(projectRoot, "configs.json");

const CONFIG_KEYS = [
  "pusherKey", "pusherCluster", "authUrl", "channel", "conversationId",
  "participantId", "accountUuid", "accountId", "channelId", "impressionId",
  "messageUrl", "pageTitle", "chunkAckTimeout", "widgetId", "accountName", "region",
];

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

export function normalizeConfig(input = {}) {
  const source = input.gecko ?? input;
  const aliases = {
    pusherKey: [source.pusherKey, source.key, source.pusher?.key],
    pusherCluster: [source.pusherCluster, source.cluster, source.pusher?.cluster],
    authUrl: [source.authUrl, source.authenticationUrl, source.auth_url],
    channel: [source.channel, source.channelName, source.channel_name, source.conversationChannel],
    conversationId: [source.conversationId, source.conversation_id],
    participantId: [source.participantId, source.participant_id],
    accountUuid: [source.accountUuid, source.account_uuid],
    accountId: [source.accountId, source.account_id, source.accountUuid, source.account_uuid],
    channelId: [source.channelId, source.channel_id],
    impressionId: [source.impressionId, source.impression_id],
    messageUrl: [source.messageUrl, source.message_url],
    pageTitle: [source.pageTitle, source.page_title],
    chunkAckTimeout: [source.chunkAckTimeout, source.chunk_ack_timeout],
    widgetId: [source.widgetId, source.widget_id],
    accountName: [source.accountName, source.account_name],
    region: [source.region],
  };
  return Object.fromEntries(CONFIG_KEYS
    .map((key) => [key, first(...aliases[key])])
    .filter(([, value]) => value !== undefined));
}

function rawEntries() {
  if (!fs.existsSync(configPath)) throw new Error(`Missing ${configPath}. Run: npm run config:add -- <page-url>`);
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.configs)) return raw.configs;
  if (Array.isArray(raw.profiles)) return raw.profiles;
  return [raw];
}

export function configIdentity(config) {
  const normalized = normalizeConfig(config);
  return normalized.channel || normalized.conversationId || normalized.channelId
    || normalized.widgetId || `${normalized.accountUuid ?? ""}:${normalized.messageUrl ?? ""}`;
}

export function dedupeConfigs(configs) {
  const unique = new Map();
  for (const config of configs) {
    const normalized = normalizeConfig(config);
    const identity = configIdentity(normalized);
    if (!unique.has(identity)) unique.set(identity, normalized);
    else unique.set(identity, { ...unique.get(identity), ...normalized });
  }
  return [...unique.values()];
}

export function readConfigEntries() {
  return dedupeConfigs(rawEntries());
}

export function listConfigEntries() {
  return readConfigEntries().map(withConversation);
}

export function writeConfigEntries(configs) {
  const entries = dedupeConfigs(configs);
  fs.writeFileSync(configPath, `${JSON.stringify({ configs: entries }, null, 2)}\n`);
  return entries;
}

function withConversation(config) {
  const normalized = normalizeConfig(config);
  if (normalized.channel && !normalized.conversationId) {
    normalized.conversationId = normalized.channel.replace(/^private-conversation-/, "");
  }
  if (normalized.conversationId && !normalized.channel) {
    normalized.channel = `private-conversation-${normalized.conversationId}`;
  }
  return normalized;
}

export function loadConfig({ requireConversation = false, index = null, accountName = process.env.GECKO_ACCOUNT ?? null } = {}) {
  const entries = listConfigEntries();
  const usable = entries.filter((entry) => entry.channel || entry.conversationId);
  const accountMatches = accountName
    ? usable.filter((entry) => String(entry.accountName ?? "").toLowerCase() === String(accountName).toLowerCase())
    : usable;
  if (accountName && !accountMatches.length) {
    throw new Error(`No active Gecko profile named "${accountName}" exists in ${configPath}`);
  }
  const selected = Number.isInteger(index)
    ? entries[index]
    : accountMatches[Math.floor(Math.random() * accountMatches.length)] ?? entries[0];
  if (!selected) throw new Error(`No configurations are available in ${configPath}`);

  if (!usable.length) {
    const conversationId = ulid();
    selected.conversationId = conversationId;
    selected.channel = `private-conversation-${conversationId}`;
    selected.generatedConversation = true;
  }
  if (requireConversation && !selected.channel) {
    throw new Error(`Configuration in ${configPath} has no active conversation`);
  }
  return selected;
}

export function saveConfig(config) {
  const normalized = withConversation(config);
  const entries = readConfigEntries();
  const identity = configIdentity(normalized);
  const merged = entries.some((entry) => configIdentity(entry) === identity)
    ? entries.map((entry) => configIdentity(entry) === identity ? { ...entry, ...normalized } : entry)
    : [...entries, normalized];
  writeConfigEntries(merged);
  return normalized;
}

export function resolveSessionConfig(input = {}) {
  if (!input || typeof input !== "object") return null;
  const normalized = normalizeConfig(input);
  if (!Object.keys(normalized).length) return null;
  const entries = listConfigEntries();
  const matched = entries.find((entry) => {
    if (normalized.accountName && entry.accountName && String(normalized.accountName).toLowerCase() === String(entry.accountName).toLowerCase()) return true;
    if (normalized.accountUuid && entry.accountUuid && normalized.accountUuid === entry.accountUuid) return true;
    if (normalized.accountId && entry.accountId && normalized.accountId === entry.accountId) return true;
    if (normalized.channelId && entry.channelId && normalized.channelId === entry.channelId) return true;
    if (normalized.channel && entry.channel && normalized.channel === entry.channel) return true;
    if (normalized.conversationId && entry.conversationId && normalized.conversationId === entry.conversationId) return true;
    if (normalized.widgetId && entry.widgetId && normalized.widgetId === entry.widgetId) return true;
    return false;
  });
  if (matched) {
    return normalizeConfig({ ...matched, ...normalized });
  }
  return normalized;
}

