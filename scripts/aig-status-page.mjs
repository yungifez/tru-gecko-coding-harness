export function serveStatusPage(response) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AIG test connections</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:60px auto;padding:0 24px;color:#233044;background:#f6f8fb}section{background:white;border:1px solid #dce2eb;border-radius:12px;padding:24px;margin:20px 0}h1,h2{line-height:1.2}code{background:#edf1f6;padding:3px 6px;border-radius:4px}a{color:#205bbc}small{color:#536176}</style>
<h1>AIG test connections</h1><p>Local API services for Tencent Zhuque Lab AI-Infra-Guard.</p>
<section><h2>Claude attacker and judge</h2>
<p>Base URL: <code>http://127.0.0.1:4185/v1</code><br>
Model: <code>claude-cli</code><br>API key placeholder: <code>local-cli</code></p>
<p>The bridge uses the existing Claude CLI sign-in. Claude's workspace tools are disabled.</p>
<a href="http://127.0.0.1:4185/health">Check bridge status</a></section>
<section><h2>TRU harness target</h2>
<p>URL: <code>http://127.0.0.1:4184</code><br>Endpoint: <code>/chat</code><br>
Method: <code>POST</code><br>Body: <code>{"message":"{{prompt}}"}</code><br>Response parser: <code>reply</code></p>
<p>Tool operations use a disposable workspace. The saved TRU conversation is reused.</p>
<a href="http://127.0.0.1:4184/health">Check target status</a></section>
<small>This page shows connection settings. The AIG scan runs through its CLI; no AIG dashboard is installed.</small></html>`);
}
