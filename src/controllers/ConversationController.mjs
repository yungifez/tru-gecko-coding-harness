export class ConversationController {
  constructor({ gecko, sessions }) {
    this.gecko = gecko;
    this.sessions = sessions;
  }

  state(_request, response) {
    response.json(this.gecko.state());
  }

  async history(_request, response) {
    response.json(await this.gecko.transcript());
  }

  async send(request, response) {
    const body = request.body ?? {};
    if (!body.content?.trim()) return response.error(422, "Message content is required");
    response.json(this.gecko.send(body.content.trim()));
  }

  async resume(request, response) {
    response.json(await this.gecko.resume(request.params.id));
  }

  async start(request, response) {
    const body = request.body ?? {};
    if (!body.channel && !body.conversationId) return response.error(422, "A conversation ID or channel is required");
    response.json(await this.gecko.startConversation(body));
  }

  systemPrompt(request, response) {
    response.json(this.gecko.setSystemPrompt(request.body.prompt));
  }
}
