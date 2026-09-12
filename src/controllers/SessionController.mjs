export class SessionController {
  constructor({ sessions, gecko }) {
    this.sessions = sessions;
    this.gecko = gecko;
  }

  index(_request, response) {
    response.json(this.sessions.all().map((session) => session.toJSON()));
  }

  async create(request, response) {
    const session = this.sessions.create(request.body?.systemPrompt ?? "coding");
    response.status(201).json(await this.gecko.resume(session.id));
  }
}
