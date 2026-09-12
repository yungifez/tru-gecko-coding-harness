import test from "node:test";
import assert from "node:assert/strict";
import { markdownToTerminal } from "../src/markdown.mjs";

test("renders agent markdown structure for the terminal", () => {
  const output = markdownToTerminal("## Result\n\n- **Passed**\n- `npm test`\n\n```js\nconsole.log('ok')\n```");
  assert.match(output, /▌ Result/);
  assert.match(output, /- Passed/);
  assert.match(output, /- npm test/);
  assert.match(output, /│ console\.log\('ok'\)/);
  assert.doesNotMatch(output, /\*\*|```/);
});
