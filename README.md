# Geiko Bot coding harness

This is a small coding harness for a Gecko conversation channel. It connects over Pusher WebSocket, authenticates the configured conversation, sends typed messages, and renders typing indicators and streamed bot responses.

The `--demo` mode remains offline and simulates the same event flow. The `GeckoHarness` class handles the event stream, while `GeckoClient` owns the live WebSocket and authentication.

## Run

```sh
npm install
npm start
npm run cli
npm start -- --debug
npm run demo
npm test
```

`npm start` opens the full-screen terminal UI. It provides a bordered conversation panel, a persistent message composer, session switching, remote history, workspace actions, visible tool activity, and connection status. It starts a new remote conversation for each fresh local session, so the bot does not resume the profile's previous chat. It mints the conversation from a client-generated ULID and does not restore the remote transcript. Use `/resume`, `--session ID`, or `GECKO_RESUME=1` to continue an existing conversation, and `/history` to view a transcript. Use `/help` for commands. `Ctrl+C` copies a selection, stops active work, or exits when idle. Both the full-screen TUI and `npm run cli` execute the same callable workspace and web tools. Gecko connection settings are loaded from the root `configs.json` file.

To capture the current Gecko settings from a page that exposes `window.GeckoChatSettings`, run:

```sh
npm run config:add -- https://your-gecko-page.example
```

The script uses the installed Chromium browser, waits for the page's delayed Gecko settings, normalizes common setting names, merges the result into `configs.json`, and removes duplicate profiles. Set `CHROMIUM_PATH` when Chromium is installed somewhere else.

If the page has loaded Gecko transport settings but no active chat yet, the command keeps any existing active conversation profiles and saves the reusable transport metadata. Start or connect a conversation later from the web UI by entering its conversation ID or private channel.

`configs.json` stores profiles under `configs`. Each client randomly selects a profile with a conversation channel when it starts, so adding several captured conversations distributes new harness sessions across them. Profiles are deduplicated by channel, conversation ID, or channel ID. A page capture that only contains widget metadata updates the matching profile instead of replacing its working conversation.

To force a specific profile for one launch, set `GECKO_ACCOUNT`, for example `GECKO_ACCOUNT=uci npm start` or `GECKO_ACCOUNT=tru npm run cli`. Without that variable, startup selects randomly from every active profile.

Use `npm start -- --debug` to show the Pusher socket, authentication status, subscribed channel, inbound event names, outbound message IDs, and the participant/sender selected for each message. Authentication signatures and full message payloads are not printed. The participant and account identifiers can be overridden with `GECKO_PARTICIPANT_ID` and `GECKO_ACCOUNT_UUID`.

Each launch creates a local session under `sessions/` and prints its ID. Resume it with:

```sh
npm start -- --session SESSION_ID
```

Inside either interface, `/new` starts a new remote conversation on the current profile and connects a fresh local session to it. `/resume SESSION_ID` switches to a saved session and reconnects to its conversation. `/history` prints its transcript. `/sessions` lists saved sessions. `/config` selects a saved Gecko profile and starts a new remote conversation on it. `/new` and `/config` mint the conversation from a client-generated ULID. They do not reopen the profile's saved channel and do not need a browser. `/system coding`, `/system concise`, or `/system debugging` selects a prompt preset. A custom prompt can follow `/system`.

`/history` retrieves the active Gecko conversation transcript through the public download endpoint and renders its Bot and visitor messages. If the remote transcript is unavailable, it falls back to the local session messages. The web UI provides the same transcript through its `Remote history` button and `/api/conversation/history`.

The session ID, system prompt, transcript, and compact history are included in the outgoing Gecko message metadata. The remote conversation still controls its own server-side context; local resume restores the harness context and reconnects to the configured Gecko channel.

The harness also sends a safe local development context with each request: project root, operating system, Node version, package scripts and dependencies, visible file names, and Git status. It does not expose file contents or run arbitrary commands. Use `/context` to inspect the current snapshot and `/refresh` after changing files. The available local skills are `workspace-context`, `session-memory`, and `gecko-events`.

## AI-Infra-Guard tests

The pinned Tencent Zhuque Lab AI-Infra-Guard source is included in `vendor/ai-infra-guard`. The TRU identity tests use AIG's direct-injection detector with Claude as the attacker and judge. Run the entire suite with a single command:

```sh
npm run aig:scan -- --judge claude
# or shorthand:
npm run aig
```

The scan runner automatically provisions the isolated `.aig-venv` Python environment (installing `vendor/ai-infra-guard/agent-scan/requirements.txt`) and boots the local Claude bridge and TRU adapter services if they are not already running. When the scan finishes, any services started by the runner are cleanly shut down.

To run the bridge and adapter persistently by themselves:
```sh
npm run aig:services
```

Keep evaluator credentials in the environment. Do not add them to `configs.json`, reports, or the vendored source.

It also includes a controlled tool registry. The available tools include workspace inspection and editing, session and Gecko event helpers, `network.diagnostics`, and `web.search`. Web search returns bounded result titles, URLs, snippets, and a direct Google search URL. Use `/tools` to list tools, `/tool NAME JSON` to invoke one, or `/websearch QUERY` and `/google QUERY` for a direct search. File writes stay inside the workspace and are limited to 100 KB; checked patch application still requires explicit approval.

Type `@src/file.mjs` in a prompt to attach that file’s bounded contents automatically. Type `!npm run test` to run a package script through the safe script tool; arbitrary shell commands are rejected. Use `/doctor` to inspect the connection and harness state safely.

Use `/apply PATCH_FILE` for an interactive patch approval. The patch is checked with `git apply --check` before it changes the workspace.

## Web UI architecture

Run `npm run web` and open `http://localhost:4173`. The web application follows a Laravel-style MVC layout:

- `src/models` contains session models.
- `src/controllers` handles HTTP actions.
- `src/services` owns Gecko, workspace, session, and event-bus logic.
- `src/views` contains the page view.
- `public` contains browser JavaScript and CSS.
- `src/server.mjs` wires routes and dependencies.

The browser receives live Gecko events through Server-Sent Events. The browser never receives Gecko credentials or executes workspace commands directly; those operations stay on the server.

Large prompts use an experimental ordered transfer protocol. The harness gives the model the protocol markers `[[HARNESS_CONTINUE]]`, `[[HARNESS_CHUNK]]`, and `[[HARNESS_DONE]]`. It sends numbered context chunks below the Pusher event limit, waits for an empty or continuation response, sends an empty acknowledgement, and advances to the next chunk. The UI suppresses empty protocol messages and only displays the final response. A timeout advances a stalled transfer so the conversation cannot remain locked indefinitely.
