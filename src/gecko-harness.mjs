export class GeckoHarness {
  constructor({ output = console.log, debug = false, onMessage = null, onEvent = null, onStreamComplete = null } = {}) {
    this.output = output;
    this.debug = debug;
    this.onMessage = onMessage;
    this.onEvent = onEvent;
    this.onStreamComplete = onStreamComplete;
    this.streamedMessages = new Map();
    this.displayedMessages = new Set();
    this.turnReplies = new Set();
  }

  emit(...values) {
    this.output(values.join(" "));
  }

  debugLog(...values) {
    if (this.debug) this.emit("[debug]", ...values);
  }

  record(message) {
    this.onMessage?.(message);
  }

  parseData(data) {
    if (typeof data !== "string") return data;
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  cleanProtocolText(text) {
    return text.replace(/\[\[HARNESS_(?:CONTINUE|ACK|CHUNK|DONE)\]\]/g, "").trim();
  }

  // Gecko can deliver one reply through both stream completion and
  // messageWasAdded, sometimes under different IDs. In one turn, a second
  // reply with the same text is a repeated delivery, not a new message.
  isRepeatedReply(text) {
    const key = this.cleanProtocolText(text);
    if (this.turnReplies.has(key)) return true;
    this.turnReplies.add(key);
    return false;
  }

  renderChatMessage({ id, sender, text }) {
    if (!text?.trim() || (id && this.displayedMessages.has(id))) return;
    if (id) this.displayedMessages.add(id);
    if (sender !== "You" && this.isRepeatedReply(text)) return;
    this.debugLog(
      `Rendering message sender=${sender}`,
      `message_id=${id ?? "missing"}`,
    );
    // Callers with onMessage render the durable message themselves. Emitting
    // it here as well would print the same response twice.
    if (!this.onMessage) this.emit(`${sender}: ${text}`);
    this.record({
      role: sender === "You" ? "user" : "assistant",
      content: text,
      messageId: id,
      sender,
    });
  }
  renderEvent(message) {
    const data = this.parseData(message.data);
    this.onEvent?.({ event: message.event, data, channel: message.channel ?? null });
    this.debugLog(`Dispatching event=${message.event}`);

    switch (message.event) {
      case "client-participantTyping":
        this.emit(data?.isTyping ? "You are typing..." : "You stopped typing.");
        return;

      case "botTyping":
        this.emit(
          data?.typing ? "Geiko Bot is typing..." : "Geiko Bot stopped typing.",
        );
        return;

      case "client-sendMessage":
        // Each outbound message starts a new turn, so the bot may repeat itself.
        this.turnReplies.clear();
        this.renderChatMessage({
          id: data?.messageId,
          sender: "You",
          text: data?.entryText,
        });
        return;

      case "messageWasAdded": {
        const msg = data?.message ?? data;
        const sender =
          msg?.participant?.name ??
          (msg?.senderType === "CONTACT"
            ? "You"
            : msg?.messageType === "Bot"
              ? "Geiko Bot"
              : (msg?.senderType ?? msg?.messageType ?? "Unknown"));
        this.debugLog(
          `Resolved message recipient/sender=${sender}`,
          `participant=${msg?.participant?.name ?? "none"}`,
          `sender_type=${msg?.senderType ?? "none"}`,
          `message_type=${msg?.messageType ?? "none"}`,
        );
        this.renderChatMessage({ id: msg?.id, sender, text: msg?.entryText });
        return;
      }

      case "botMessageStreamed": {
        const messageId = data?.messageId ?? data?.message?.id;
        const text = this.cleanProtocolText(data?.message?.entryText ?? data?.entryText ?? "");
        if (!messageId || !text) return;
        const previous = this.streamedMessages.get(messageId) ?? "";
        const current =
          previous && text.startsWith(previous) ? text : previous + text;
        this.streamedMessages.set(messageId, current);
        // The final recorded message is the canonical display path when the
        // client supplies onMessage. Keep streaming output for the basic
        // standalone harness only.
        if (!this.onMessage) this.emit(`Geiko Bot [stream]: ${current}`);
        return;
      }

      case "botMessageStreamCompleted": {
        const messageId = data?.message?.id ?? data?.messageId;
        const rawText = this.streamedMessages.get(messageId) ?? "";
        const text = this.cleanProtocolText(rawText);
        // messageWasAdded may already have recorded this reply.
        if (text && !this.displayedMessages.has(messageId)) {
          this.displayedMessages.add(messageId);
          if (!this.isRepeatedReply(text)) this.record({ role: "assistant", content: text, messageId });
        }
        this.streamedMessages.delete(messageId);
        this.onStreamComplete?.({ messageId, text: rawText, visibleText: text });
        return;
      }

      case "conversationWasReopened":
        this.emit(
          `[Conversation reopened: ${data?.reopenReason ?? "unknown"}]`,
        );
        return;
      case "conversationWasClosed":
        this.emit("[Conversation closed]");
        return;
      case "conversationWasMerged":
        this.emit(`[Conversation merged] ${JSON.stringify(data)}`);
        return;
      case "client-readReceipt":
      case "pusher_internal:member_added":
      case "pusher_internal:member_removed":
        return;
      default:
        if (this.debug)
          this.emit(
            `[Unknown event: ${message.event}] ${JSON.stringify(data)}`,
          );
    }
  }
}
