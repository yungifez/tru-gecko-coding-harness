import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

function safeId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
  return id;
}

export class SessionStore {
  constructor(directory = path.join(process.cwd(), "sessions")) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
  }

  pathFor(id) {
    return path.join(this.directory, `${safeId(id)}.json`);
  }

  create({ id = ulid(), systemPrompt, title = null, gecko = {}, persist = true } = {}) {
    const session = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      systemPrompt,
      title,
      gecko,
      messages: [],
    };
    if (persist) this.save(session);
    return session;
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(this.pathFor(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  save(session) {
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.pathFor(session.id), `${JSON.stringify(session, null, 2)}\n`);
    return session;
  }

  append(session, message) {
    session.messages.push({
      ...message,
      timestamp: message.timestamp ?? new Date().toISOString(),
    });
    return this.save(session);
  }

  list() {
    return fs.readdirSync(this.directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => this.load(file.slice(0, -5)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
