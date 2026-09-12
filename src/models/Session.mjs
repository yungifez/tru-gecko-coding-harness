export class Session {
  constructor(attributes) {
    Object.assign(this, attributes);
  }

  get recentMessages() {
    return this.messages.slice(-30);
  }

  append(message) {
    this.messages.push({ ...message, timestamp: message.timestamp ?? new Date().toISOString() });
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title ?? null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      systemPrompt: this.systemPrompt,
      gecko: this.gecko ?? {},
      messages: this.messages,
    };
  }
}
