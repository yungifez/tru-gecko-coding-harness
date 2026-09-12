import { ToolRegistry } from "../tool-registry.mjs";
import { WorkspaceTools } from "../workspace-tools.mjs";
import { HARNESS_SKILLS } from "../local-context.mjs";

export class WorkspaceService {
  constructor(root = process.cwd(), sessionProvider = () => null) {
    this.workspace = new WorkspaceTools(root);
    this.registry = new ToolRegistry({ workspace: this.workspace, sessionProvider });
  }

  context() { return this.workspace.context(); }
  contextForRequest(message) { return this.workspace.contextForRequest(message); }
  tools() { return this.registry.manifest(); }
  skills() { return HARNESS_SKILLS; }
  invoke(name, args, options) { return this.registry.invoke(name, args, options); }
}
