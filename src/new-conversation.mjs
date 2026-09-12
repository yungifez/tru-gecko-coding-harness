import { ulid } from "ulid";
import { pullGeckoConfig } from "../scripts/add-to-config.js";

/**
 * Start a new Gecko conversation without a browser.
 *
 * The server accepts a client-generated ULID as the conversation ID. We mint a
 * new ULID, build its private channel, and keep the profile transport data
 * (Pusher key, auth URL, account, channel, and page). This avoids resuming the
 * saved remote chat and does not need Playwright.
 */
export function mintConversation(config = {}) {
  const conversationId = ulid();
  return {
    ...config,
    conversationId,
    channel: `private-conversation-${conversationId}`,
    generatedConversation: true,
  };
}

/**
 * Reload a widget in a fresh browser context so Gecko creates a new
 * conversation. Reusing the saved channel would resume the old remote chat.
 *
 * Prefer mintConversation for a fast, browser-free new conversation. Use this
 * only when you need the page to register the conversation through the widget.
 */
export async function captureNewConversation(config) {
  if (!config?.messageUrl) throw new Error("This Gecko profile has no message URL for starting a new conversation");
  const captured = await pullGeckoConfig(config.messageUrl);
  if (!captured?.channel || !captured?.conversationId) {
    throw new Error(`The page did not create an active Gecko conversation: ${config.messageUrl}`);
  }
  return { ...config, ...captured };
}
