import { GeckoClient } from "../gecko-client.mjs";
import { compactHistory } from "../prompts.mjs";
import { collectLocalContext, HARNESS_SKILLS } from "../local-context.mjs";
import { loadConfig, saveConfig, resolveSessionConfig, normalizeConfig } from "../config.mjs";
import { mintConversation } from "../new-conversation.mjs";
import { fetchTranscript } from "../gecko-transcript.mjs";
import { ensureSessionTitle } from "../session-title.mjs";

export class GeckoService {
  constructor({ sessions, workspace, events }) {
    this.sessions = sessions;
    this.workspace = workspace;
    this.events = events;
    this.session = null;
    this.client = null;
    this.connected = false;
    this.config = loadConfig();
  }

  async boot(sessionId = null, conversation = {}) {
    // A booted web session is provisional until the user sends a message or
    // binds a conversation. Avoid leaving an empty file on every restart.
    this.session = sessionId ? this.sessions.find(sessionId) : this.sessions.create("coding", null, { persist: false });
    if (!this.session) throw new Error(`Session not found: ${sessionId}`);
    if (this.session.gecko?.channel) {
      const resolved = resolveSessionConfig(this.session.gecko);
      this.config = resolved ? { ...resolved } : { ...this.session.gecko };
    } else if (!conversation.channel && !conversation.conversationId) {
      // No saved conversation and none requested: start a new remote
      // conversation on the profile transport with a client-generated ULID.
      this.config = mintConversation(this.config);
    }
    if (conversation.channel || conversation.conversationId) {
      const resolved = resolveSessionConfig(conversation);
      this.config = resolved ? { ...resolved, ...conversation } : { ...this.config, ...conversation };
      const resolvedId = conversation.conversationId ?? conversation.channel?.replace(/^private-conversation-/, "");
      this.config.conversationId = resolvedId;
      this.config.channel = conversation.channel ?? `private-conversation-${resolvedId}`;
      this.session.gecko = normalizeConfig(this.config);
      this.sessions.save(this.session);
      saveConfig(this.config);
    }
    if (!this.config.channel) {
      this.connected = false;
      this.client = null;
      return this.state();
    }
    const activeSession = this.session;
    const options = {
      output: () => {},
      sessionId: this.session.id,
      systemPrompt: this.session.systemPrompt,
      history: compactHistory(this.session.messages),
      skills: HARNESS_SKILLS,
      tools: this.workspace.tools(),
      localContext: collectLocalContext(),
      onMessage: (message) => {
        // A response from a socket that was replaced during a config/session
        // switch belongs to the old session and must be ignored.
        if (this.session !== activeSession) return;
        this.sessions.append(activeSession, message);
        this.events.publish({ type: "message", message });
      },
      onEvent: (event) => this.events.publish({ type: "gecko_event", ...event }),
    };
    // Keep the service state and WebSocket on the same randomly selected
    // profile. Otherwise GeckoClient could select a second profile here.
    this.client = new GeckoClient({ ...this.config, ...options });
    await this.client.connect();
    this.connected = true;
    this.events.publish({ type: "connection", connected: true, session: this.state() });
    return this.state();
  }

  async resume(id) {
    this.client?.close();
    this.connected = false;
    return this.boot(id);
  }

  async startConversation(conversation) {
    this.client?.close();
    this.connected = false;
    return this.boot(this.session?.id ?? null, conversation);
  }

  send(content) {
    if (!this.client || !this.connected) throw new Error("Gecko is not connected");
    if (ensureSessionTitle(this.session, content)) this.sessions.save(this.session);
    this.session.gecko = normalizeConfig(this.config);
    this.sessions.save(this.session);
    this.client.sendMessage(content, {
      sessionId: this.session.id,
      systemPrompt: this.session.systemPrompt,
      history: compactHistory(this.session.messages),
      skills: HARNESS_SKILLS,
      tools: this.workspace.tools(),
      conversation: this.config.channel ? { id: this.config.conversationId, channel: this.config.channel } : null,
      needsConversation: !this.config.channel,
      localContext: {
        ...collectLocalContext(),
        requestedFiles: this.workspace.contextForRequest(content),
      },
    });
    return this.state();
  }

  setSystemPrompt(prompt) {
    this.session.systemPrompt = prompt;
    this.sessions.save(this.session);
    this.client.setSessionContext({ sessionId: this.session.id, systemPrompt: prompt, history: compactHistory(this.session.messages) });
    return this.state();
  }

  async transcript() {
    return fetchTranscript(this.config);
  }

  state() {
    return {
      connected: this.connected,
      session: this.session?.toJSON() ?? null,
      workspace: this.workspace.context(),
      skills: this.workspace.skills(),
      tools: this.workspace.tools(),
    };
  }
}
