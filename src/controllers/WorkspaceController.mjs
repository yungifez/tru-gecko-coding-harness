export class WorkspaceController {
  constructor({ workspace }) { this.workspace = workspace; }
  context(_request, response) { response.json(this.workspace.context()); }
  tools(_request, response) { response.json(this.workspace.tools()); }
  async invoke(request, response) {
    const result = await this.workspace.invoke(request.body.name, request.body.args ?? {}, { approved: request.body.approved === true });
    response.json(result);
  }
}
