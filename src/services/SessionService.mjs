import { Session } from "../models/Session.mjs";
import { SessionStore } from "../session-store.mjs";
import { resolveSystemPrompt } from "../prompts.mjs";

export class SessionService {
  constructor(store = new SessionStore()) {
    this.store = store;
  }

  create(systemPrompt = "coding", title = null, { persist = true } = {}) {
    return this.hydrate(this.store.create({ systemPrompt: resolveSystemPrompt(systemPrompt), title, persist }));
  }

  find(id) {
    const session = this.store.load(id);
    return session ? this.hydrate(session) : null;
  }

  current(id) {
    return this.find(id) ?? this.create();
  }

  save(session) {
    this.store.save(session);
    return session;
  }

  append(session, message) {
    session.append(message);
    this.save(session);
    return session;
  }

  all() {
    return this.store.list().map((session) => this.hydrate(session));
  }

  hydrate(data) {
    return data instanceof Session ? data : new Session({ ...data, messages: data.messages ?? [] });
  }
}
