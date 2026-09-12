import WebSocket from "ws";
import { GeckoHarness } from "./gecko-harness.mjs";
import { ulid } from "ulid";
import { buildTransportPrompt, buildFullHarnessPrompt, prepareTransportData, chunkText, SAFE_EVENT_BUDGET_BYTES, byteLength } from "./chunking.mjs";
import { loadConfig } from "./config.mjs";
import { ensureGeikoIdentity } from "./prompts.mjs";

function parseData(data) {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

export class GeckoClient {
  constructor({ output = console.log, debug = false, onMessage = null, onEvent = null, ...overrides } = {}) {
    // Select a profile when a client is created so separate sessions can use
    // different saved Gecko conversations in the same process.
    this.config = { ...loadConfig(), ...overrides };
    this.debug = debug;
    this.harness = new GeckoHarness({
      output,
      debug,
      onMessage,
      onEvent: (event) => {
        if (event.event === "messageWasAdded" || event.event === "botMessageStreamed") {
          this.handleTransferResponse(event.data?.message?.entryText ?? event.data?.entryText ?? "");
        }
        onEvent?.(event);
      },
    });
    this.output = output;
    this.socket = null;
    this.connected = false;
    this.subscribed = false;
    this.activeTransfer = null;
    this.connectionGeneration = 0;
    this.pendingConnectionReject = null;
    this.onEvent = onEvent;
    this.harness.onStreamComplete = (stream) => this.handleTransferResponse(stream.text);
  }

  emit(...values) {
    this.output(values.join(" "));
  }

  debugLog(...values) {
    if (this.debug) this.emit("[debug]", ...values);
  }

  sendTransferChunk(transfer, index) {
    if (this.activeTransfer !== transfer || transfer.generation !== this.connectionGeneration) return;
    const chunk = transfer.chunks[index];
    const messageId = ulid();
    const payload = {
      conversationId: this.getConversationId(),
      participantId: this.config.participantId,
      messageId,
      channelId: this.config.channelId,
      impressionId: this.config.impressionId,
      accountId: this.config.accountId,
      messageUrl: this.config.messageUrl,
      pageTitle: this.config.pageTitle,
      sessionId: this.config.sessionId,
      transferId: transfer.id,
      chunkIndex: index,
      chunkTotal: transfer.chunks.length,
      chunked: true,
      entryText: `[HARNESS_CONTEXT_CHUNK transfer=${transfer.id} index=${index + 1}/${transfer.chunks.length}]\n${chunk}\n[/HARNESS_CONTEXT_CHUNK]`,
    };
    const bytes = byteLength({ event: "client-sendMessage", channel: this.config.channel, data: JSON.stringify(payload) });
    if (bytes > SAFE_EVENT_BUDGET_BYTES) throw new Error(`Chunk ${index + 1} is ${bytes} bytes; chunk budget exceeded`);
    transfer.waitingFor = messageId;
    transfer.index = index;
    this.sendRaw({ event: "client-sendMessage", channel: this.config.channel, data: JSON.stringify(payload) });
    this.debugLog(`Sent context chunk ${index + 1}/${transfer.chunks.length}`, `transfer_id=${transfer.id}`, `event_bytes=${bytes}`);
    clearTimeout(transfer.timeout);
    transfer.timeout = setTimeout(() => {
      if (this.activeTransfer !== transfer || transfer.generation !== this.connectionGeneration) return;
      this.debugLog(`Chunk acknowledgement timeout; advancing`, `transfer_id=${transfer.id}`, `chunk=${index + 1}`);
      this.sendNextTransferChunk();
    }, this.config.chunkAckTimeout ?? 12_000);
  }

  sendNextTransferChunk() {
    const transfer = this.activeTransfer;
    if (!transfer || transfer.generation !== this.connectionGeneration) return;
    clearTimeout(transfer.timeout);
    if (transfer.index + 1 >= transfer.chunks.length) {
      this.debugLog(`All context chunks sent; awaiting final model response`, `transfer_id=${transfer.id}`);
      this.sendEmptyTransferAck(transfer);
      transfer.awaitingFinal = true;
      return;
    }
    this.sendEmptyTransferAck(transfer);
    this.sendTransferChunk(transfer, transfer.index + 1);
  }

  sendEmptyTransferAck(transfer) {
    const payload = {
      conversationId: this.getConversationId(), participantId: this.config.participantId,
      messageId: ulid(), channelId: this.config.channelId, impressionId: this.config.impressionId,
      accountId: this.config.accountId, messageUrl: this.config.messageUrl, pageTitle: this.config.pageTitle,
      sessionId: this.config.sessionId, transferId: transfer.id, chunkAck: true, entryText: "",
    };
    this.sendRaw({ event: "client-sendMessage", channel: this.config.channel, data: JSON.stringify(payload) });
    this.debugLog(`Sent empty chunk acknowledgement`, `transfer_id=${transfer.id}`);
  }

  handleTransferResponse(text = "") {
    const transfer = this.activeTransfer;
    if (!transfer || transfer.generation !== this.connectionGeneration) return;
    const continuation = !text.trim() || text.includes("[[HARNESS_CONTINUE]]") || text.includes("[[HARNESS_ACK]]") || text.includes("[[HARNESS_CHUNK]]");
    const done = text.includes("[[HARNESS_DONE]]");
    if (done) {
      clearTimeout(transfer.timeout);
      this.debugLog(`Model marked transfer complete`, `transfer_id=${transfer.id}`);
      this.activeTransfer = null;
      return;
    }
    if (continuation && !transfer.awaitingFinal) this.sendNextTransferChunk();
  }

  async connect() {
    this.cancelTransfer();
    this.cancelConnection(new Error("Gecko connection superseded"));
    const generation = ++this.connectionGeneration;
    const previousSocket = this.socket;
    previousSocket?.close();
    const { pusherKey, pusherCluster, authUrl } = this.config;
    if (!this.config.channel) {
      // Keep a client usable when a caller supplies only transport settings.
      // The server may reject a generated channel, but the harness can then
      // report that connection failure and the UI can select a real one.
      this.config.conversationId ??= ulid();
      this.config.channel = `private-conversation-${this.config.conversationId}`;
      this.debugLog(`No saved channel; generated ${this.config.channel}`);
    }
    const { channel } = this.config;
    const websocketUrl =
      `wss://ws-${pusherCluster}.pusher.com/app/${pusherKey}` +
      "?protocol=7&client=js&version=8.4.0&flash=false";

    const socket = new WebSocket(websocketUrl);
    this.socket = socket;
    const isCurrent = () => this.socket === socket && this.connectionGeneration === generation;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          if (this.pendingConnectionReject === fail) this.pendingConnectionReject = null;
          reject(error);
        }
      };
      this.pendingConnectionReject = fail;

      const authenticateAndSubscribe = async (socketId) => {
        if (!isCurrent()) return;
        if (!socketId)
          throw new Error("Gecko did not provide a Pusher socket ID");
        const body = new URLSearchParams({
          socket_id: socketId,
          channel_name: channel,
        });
        if (this.config.participantId)
          body.set("participant_id", this.config.participantId);
        if (this.config.accountUuid)
          body.set("account_uuid", this.config.accountUuid);
        const response = await fetch(authUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "*/*",
            ...(this.config.messageUrl ? {
              Origin: new URL(this.config.messageUrl).origin,
              Referer: this.config.messageUrl,
            } : {}),
          },
          body,
        });
        const responseText = await response.text();
        if (!isCurrent()) return;
        this.debugLog(`Auth response status=${response.status}`, `ok=${response.ok}`);
        if (!response.ok)
          throw new Error(`Auth endpoint returned ${response.status}: ${responseText}`);
        let auth;
        try { auth = JSON.parse(responseText); }
        catch { throw new Error("Auth endpoint returned invalid JSON"); }
        if (!auth.auth) throw new Error('Auth response is missing the "auth" field');
        this.debugLog(
          `Auth accepted for channel=${channel}`,
          `participant_id=${this.config.participantId ?? "absent"}`,
          `account_uuid=${this.config.accountUuid ?? "absent"}`,
          `channel_data=${auth.channel_data ? "present" : "absent"}`,
        );
        const data = { channel, auth: auth.auth };
        if (auth.channel_data) data.channel_data = auth.channel_data;
        socket.send(JSON.stringify({ event: "pusher:subscribe", data }));
      };

      socket.on("open", () => {
        if (!isCurrent()) return;
        this.debugLog(`Pusher cluster=${pusherCluster}`, `channel=${channel}`);
        this.emit("WebSocket connected. Authenticating Gecko conversation...");
      });
      socket.on("error", (error) => {
        if (isCurrent()) fail(error);
      });
      socket.on("close", (code, reason) => {
        if (!isCurrent()) return;
        this.cancelTransfer();
        this.connected = false;
        this.subscribed = false;
        this.emit(
          `Gecko connection closed (${code})${reason.length ? `: ${reason}` : ""}`,
        );
        if (!settled)
          fail(new Error(`WebSocket closed before subscription (${code})`));
      });
      socket.on("message", async (buffer) => {
        if (!isCurrent()) return;
        const message = this.parseMessage(buffer);
        if (!message) return;
        if (message.channel && message.channel !== channel) return;

        if (message.event === "pusher:connection_established") {
          try {
            const established = parseData(message.data);
            this.debugLog(
              `Pusher connection established; socket_id=${established?.socket_id ?? "missing"}`,
            );
            await authenticateAndSubscribe(established?.socket_id);
          } catch (error) {
            fail(error);
            this.emit(`Gecko authentication failed: ${error.message}`);
            if (isCurrent()) socket.close();
          }
          return;
        }

        if (message.event === "pusher:ping") {
          this.debugLog("Received pusher:ping; sending pusher:pong");
          socket.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          return;
        }

        if (
          message.event === "pusher_internal:subscription_succeeded" ||
          message.event === "pusher:subscription_succeeded"
        ) {
          if (!isCurrent()) return;
          this.connected = true;
          this.subscribed = true;
          this.debugLog(
            `Subscription succeeded; subscribed_channel=${channel}`,
          );
          this.emit(`Connected to Gecko conversation ${channel}`);
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (
          message.event === "pusher:error" ||
          message.event === "pusher:subscription_error"
        ) {
          const detail = JSON.stringify(parseData(message.data));
          fail(new Error(`Pusher error: ${detail}`));
          this.emit(`Pusher error: ${detail}`);
          if (isCurrent()) socket.close();
          return;
        }

        this.debugLog(
          `Inbound event=${message.event}`,
          `channel=${message.channel ?? channel}`,
        );
        if (isCurrent()) this.harness.renderEvent(message);
      });
    });
  }

  parseMessage(buffer) {
    try {
      return JSON.parse(buffer.toString());
    } catch {
      return null;
    }
  }

  sendRaw(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gecko socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  setSessionContext({ sessionId, systemPrompt, history = [], skills = this.config.skills, localContext = this.config.localContext, tools = this.config.tools } = {}) {
    this.config.sessionId = sessionId;
    this.config.systemPrompt = ensureGeikoIdentity(systemPrompt);
    this.config.history = history;
    this.config.skills = skills;
    this.config.localContext = localContext;
    this.config.tools = tools;
    this.debugLog(
      `Session context updated`,
      `session_id=${sessionId ?? "absent"}`,
      `prompt_chars=${this.config.systemPrompt.length}`,
      `skills=${skills.length}`,
      `tools=${tools.length}`,
      `history_items=${history.length}`,
    );
  }

  setConversation({ channel, conversationId, channelId, impressionId, messageUrl, pageTitle } = {}) {
    if (!channel && !conversationId) throw new Error("A conversation channel or ID is required");
    const resolvedConversationId = conversationId ?? channel?.replace(/^private-conversation-/, "");
    this.config.channel = channel ?? `private-conversation-${resolvedConversationId}`;
    this.config.conversationId = resolvedConversationId;
    if (channelId !== undefined) this.config.channelId = channelId;
    if (impressionId !== undefined) this.config.impressionId = impressionId;
    if (messageUrl !== undefined) this.config.messageUrl = messageUrl;
    if (pageTitle !== undefined) this.config.pageTitle = pageTitle;
  }

  getConversationId() {
    const prefix = "private-conversation-";

    if (!this.config.channel.startsWith(prefix)) {
      throw new Error("Invalid Gecko private conversation channel");
    }

    return this.config.channel.slice(prefix.length);
  }

  sendMessage(entryText, context = {}) {
    if (!this.subscribed) {
      throw new Error("Gecko conversation is not subscribed");
    }
    // Only one ordered context transfer can be active on a conversation. A
    // newer user message supersedes an unfinished transfer and its timer.
    this.cancelTransfer();

    const conversationId = this.getConversationId();

    const messageId = ulid();

    const systemPrompt = ensureGeikoIdentity(context.systemPrompt ?? this.config.systemPrompt);
    const data = {
      conversationId,

      participantId: this.config.participantId,

      entryText,

      messageId,

      channelId: this.config.channelId,

      impressionId: this.config.impressionId,

      messageUrl: this.config.messageUrl,

      pageTitle: this.config.pageTitle,

      accountId: this.config.accountId,

      sessionId: context.sessionId ?? this.config.sessionId,

      systemPrompt,

      history: context.history ?? this.config.history ?? [],

      skills: context.skills ?? this.config.skills ?? [],

      localContext: context.localContext ?? this.config.localContext ?? {},

      tools: context.tools ?? this.config.tools ?? [],
    };

    const fullHarnessText = buildFullHarnessPrompt({
      systemPrompt: data.systemPrompt,
      skills: data.skills,
      localContext: data.localContext,
      history: data.history,
      tools: data.tools,
      userMessage: entryText,
    });
    const harnessEntryText = buildTransportPrompt({
      systemPrompt: data.systemPrompt,
      skills: data.skills,
      localContext: data.localContext,
      history: data.history,
      tools: data.tools,
      userMessage: entryText,
    });
    if (this.debug || process.env.GECKO_DEBUG_PROMPT === "1") {
      this.debugLog("[prompt] systemPrompt BEGIN", systemPrompt, "[prompt] systemPrompt END");
      this.debugLog("[prompt] transportEntryText BEGIN", harnessEntryText, "[prompt] transportEntryText END");
      this.debugLog("[prompt] tools", JSON.stringify(data.tools.map(({ name }) => name)));
    }
    data.rawEntryText = entryText;
    if (byteLength(fullHarnessText) > SAFE_EVENT_BUDGET_BYTES) {
      if (this.debug || process.env.GECKO_DEBUG_PROMPT === "1") {
        this.debugLog("[prompt] fullChunkedPrompt BEGIN", fullHarnessText, "[prompt] fullChunkedPrompt END");
      }
      const transfer = {
        id: ulid(),
        generation: this.connectionGeneration,
        chunks: chunkText(fullHarnessText, 5_700),
        index: -1,
        awaitingFinal: false,
      };
      this.activeTransfer = transfer;
      this.debugLog(`Starting ordered context transfer`, `transfer_id=${transfer.id}`, `chunks=${transfer.chunks.length}`);
      this.sendTransferChunk(transfer, 0);
      this.harness.renderEvent({ event: "client-sendMessage", channel: this.config.channel, data: { ...data, entryText } });
      return;
    }
    const transport = prepareTransportData(data, harnessEntryText);
    const transportData = transport.data;

    this.debugLog(
      `Outbound event=client-sendMessage channel=${this.config.channel}`,
      `message_id=${messageId}`,
      `session_id=${data.sessionId ?? "absent"}`,
      `history_items=${data.history.length}`,
      `skills=${data.skills.length}`,
      `tools=${data.tools.length}`,
      `role=${systemPrompt.includes("Geiko Bot") ? "present" : "missing"}`,
      `event_bytes=${transport.bytes}`,
    );
    this.sendRaw({
      event: "client-sendMessage",
      channel: this.config.channel,
      data: JSON.stringify(transportData),
    });

    this.harness.renderEvent({
      event: "client-sendMessage",
      channel: this.config.channel,
      data: { ...data, entryText },
    });
  }

  close() {
    this.connectionGeneration += 1;
    this.cancelConnection(new Error("Gecko connection closed"));
    this.cancelTransfer();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.subscribed = false;
    socket?.close();
  }

  cancelConnection(error) {
    const reject = this.pendingConnectionReject;
    this.pendingConnectionReject = null;
    reject?.(error);
  }

  cancelTransfer() {
    if (!this.activeTransfer) return;
    clearTimeout(this.activeTransfer.timeout);
    this.activeTransfer = null;
  }
}
