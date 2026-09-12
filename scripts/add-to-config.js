import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { normalizeConfig, readConfigEntries, writeConfigEntries } from "../src/config.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_FILE = path.join(PROJECT_ROOT, "configs.json");

function normalizeCapturedConfig(settings) {
  const source = settings.gecko ?? settings;
  const normalized = normalizeConfig(source);
  if (!normalized.authUrl && normalized.region) {
    normalized.authUrl = `https://api-${normalized.region}.geckoform.com/conversations/socket/auth`;
  }
  return normalized;
}

async function pullGeckoConfig(url) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser",
  });

  const page = await browser.newPage({
    userAgent: process.env.GECKO_USER_AGENT
      || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  // Intercept the GeckoEngage public widget API response so we get Pusher
  // credentials even before any conversation has started.
  let geckoEngagePublic = null;
  page.on("response", async (res) => {
    if (/\.api\.geckoengage\.com\/chat_widgets\/[^/]+\/public/.test(res.url())) {
      try {
        const body = await res.json();
        if (body?.success && body?.data) geckoEngagePublic = body.data;
      } catch { /* ignore */ }
    }
  });

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    try {
      await page.waitForFunction(() => (
        window.GeckoChatSettings !== undefined
        || window.GeckoChatWidget?.widgetState !== undefined
        || window.GeckoEngagementWidget !== undefined
      ), {
        timeout: 30_000,
        polling: 250,
      });
    } catch {
      // Continue so we can produce a cleaner error below.
    }

    // GeckoChatSettings is often installed before the widget has fetched the
    // account and conversation state. Give the runtime a second short window
    // to expose Pusher credentials and the active conversation.
    try {
      await page.waitForFunction(() => window.GeckoChatWidget?.widgetState?.pusher?.key, {
        timeout: 15_000,
        polling: 250,
      });
    } catch {
      // A page can have a widget without an active conversation.
    }

    // --- GeckoForm path (GeckoChatSettings / GeckoChatWidget) ---
    const settings = await page.evaluate(() => {
      const settings = window.GeckoChatSettings ?? {};
      const state = window.GeckoChatWidget?.widgetState ?? {};
      const conversationId = state.activeConversationId;
      const channelId = conversationId
        ? state.conversations?.[conversationId]?.channel
        : Object.keys(state.channels ?? {})[0];
      const pusher = state.pusher ?? {};
      const accountName = settings.accountName ?? state.accountName;

      if (!Object.keys(settings).length && !Object.keys(state).length) {
        return null;
      }

      return {
        accountName,
        widgetId: settings.widgetId ?? state.widgetId,
        accountUuid: state.accountId,
        accountId: state.accountId,
        pusherKey: pusher.key,
        pusherCluster: pusher.cluster,
        authUrl: state.authUrl,
        region: state.region,
        channel: conversationId ? `private-conversation-${conversationId}` : undefined,
        conversationId,
        participantId: state.userId,
        channelId,
        impressionId: state.impressionId,
        messageUrl: location.href,
        pageTitle: document.title,
      };
    });

    if (settings) return normalizeCapturedConfig(settings);

    // --- GeckoEngage path (GeckoEngagementWidget) ---
    // The GeckoEngage widget wraps a GeckoForm chat internally. Credentials
    // are split across two APIs:
    //   1. {account}.api.geckoengage.com/chat_widgets/{id}/public  → Pusher key/cluster/region
    //   2. gag1babax2.execute-api.us-east-1.amazonaws.com/widgets/{uuid} → accountId, channelId, accountName
    const engageWidgetId = await page.evaluate(() => window.GeckoEngagementWidget?.widgetId ?? null);

    if (!engageWidgetId && !geckoEngagePublic) return null;

    // Fetch the GeckoEngage widget config from the AWS-hosted registry.
    let widgetConfig = null;
    if (engageWidgetId) {
      try {
        const res = await fetch(`https://gag1babax2.execute-api.us-east-1.amazonaws.com/widgets/${engageWidgetId}`);
        if (res.ok) widgetConfig = await res.json();
      } catch { /* network error — fall through */ }
    }

    // Extract GeckoForm credentials from the first new_chat component.
    let geckoFormCredentials = null;
    const components = widgetConfig?.configuration?.widgetComponents ?? [];
    const newChat = components.find((c) => c.type === "new_chat");
    if (newChat) {
      // chatId format: "{accountId}-{channelId}"
      const dashIndex = newChat.chatId.indexOf("-");
      if (dashIndex > 0) {
        geckoFormCredentials = {
          accountId: newChat.chatId.slice(0, dashIndex),
          accountUuid: newChat.chatId.slice(0, dashIndex),
          channelId: newChat.chatId.slice(dashIndex + 1),
          accountName: newChat.accountName ?? widgetConfig?.configuration?.accountName,
        };
      }
    }

    if (!geckoEngagePublic && !geckoFormCredentials) return null;

    const pageMetadata = await page.evaluate(() => ({
      messageUrl: location.href,
      pageTitle: document.title,
    }));

    const merged = {
      ...geckoFormCredentials,
      pusherKey: geckoEngagePublic?.pusher?.key,
      pusherCluster: geckoEngagePublic?.pusher?.cluster,
      region: geckoEngagePublic?.region,
      widgetId: geckoEngagePublic?.widgetId ?? engageWidgetId,
      ...pageMetadata,
    };

    return normalizeCapturedConfig(merged);
  } finally {
    await browser.close();
  }
}

export { pullGeckoConfig };

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error(`Usage: node ${process.argv[1]} <url>`);

    process.exit(1);
  }

  console.log(`Fetching ${url}`);

  try {
    const captured = await pullGeckoConfig(url);
    const existing = readConfigEntries();
    let entries = existing;
    if (captured) {
      // Pages can expose widget metadata before conversation data. Preserve
      // any working conversation while updating the matching profile.
      const matchingIndex = existing.findIndex((entry) =>
        (captured.widgetId && entry.widgetId === captured.widgetId)
        || (captured.accountUuid && entry.accountUuid === captured.accountUuid)
        || (captured.messageUrl && entry.messageUrl === captured.messageUrl));
      entries = matchingIndex >= 0
        ? existing.map((entry, index) => index === matchingIndex ? { ...entry, ...captured } : entry)
        : [...existing, captured];
    } else {
      console.log("No active Gecko conversation was found; saved reusable transport settings only.");
    }
    const saved = writeConfigEntries(entries);

    console.log(`Saved normalized configuration to ${path.relative(PROJECT_ROOT, OUTPUT_FILE)}`);
    console.log();
    console.log(JSON.stringify(saved, null, 2));
  } catch (error) {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
