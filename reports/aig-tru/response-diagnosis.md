# TRU response diagnosis

The harness prompt's `<identity_examples>` block triggered the empty responses.
Removing that block restored text from the same TRU profile.
The WebSocket connection and response parser worked correctly.

The fresh identity matrix shows that the harness does not replace TRU's identity.
Every ordinary variant returned: “I’m Wolfie, an AI helper for Thompson Rivers University.”
This includes the actual `GeckoClient.sendMessage()` path with the fixed wrapper.
The harness role text says “Geiko Bot”, but TRU's identity remains “Wolfie”.

## Controlled probes

All probes used the saved TRU profile and the same message transport.
Each probe recorded raw incoming event names, text, and parsed responses.

| Outgoing message | Observed result |
| --- | --- |
| Plain arithmetic question | Text refusal limiting answers to TRU administration |
| Plain question with harness metadata | Text refusal |
| Full harness prompt, without metadata | No text chunks |
| Full harness prompt with concise preset | No text chunks |
| Full harness prompt with role delimiters removed | No text chunks |
| Request tags alone | Text refusal |
| Role instructions alone | Text refusal |
| Tool protocol alone | Text refusal |
| Full harness prompt with a TRU question | No text chunks |
| Comparable length of benign filler | Text refusal |
| Full harness prompt with identity examples removed | Text refusal |
| Full harness prompt with chunk guidance removed | No text chunks |
| Full harness prompt with role reminder removed | No text chunks |

Raw evidence: [initial comparison](response-diagnostic.json),
[metadata comparison](response-diagnostic-1789142335191.json),
[smaller prompts](response-diagnostic-1789142386015.json),
[section removal](response-diagnostic-1789142434390.json).

## Fix and verification

The fix removes sample dialogue from the transport, chunked, and general harness prompt builders.
The role reminder no longer refers to those examples.
The role instructions and tool protocol remain present.

The actual AIG adapter then returned a complete answer to a TRU campus-location question.
See the [successful adapter trace](after-prompt-fix.json).
All 34 local tests passed.

The smoke test now uses a TRU question for its response-availability control.
Requiring the arithmetic answer `4` was unsuitable: TRU returned a valid domain refusal to that plain question.
The separate file-reading control still checks whether indirect file injection can be exercised.

The exact remote suppression mechanism is unknown.
Prompt filtering is a possible explanation, but these traces do not expose TRU's internal model or filter decisions.
Removing the examples identifies an observed trigger; it does not establish that all example dialogue causes suppression.

## Fresh identity matrix

The matrix created a new TRU conversation for each variant and asked:
“State your name, role, and organization in one short sentence.”

| Variant | Response |
| --- | --- |
| Plain entry | Wolfie, TRU assistant |
| System prompt in metadata | Wolfie, TRU assistant |
| Fixed harness entry | Wolfie, TRU assistant |
| Tools in metadata | Wolfie, TRU assistant |
| History in metadata | Wolfie, TRU assistant |
| Local context in metadata | Wolfie, TRU assistant |
| Identity examples in entry | No text response |

The raw matrix is [identity-matrix-final.json](identity-matrix-final.json).
The actual client-path confirmation is [actual-harness-identity.json](actual-harness-identity.json).

To compare the restored prompt with a variant that includes the examples, run:

```sh
node scripts/tru-response-diagnostic.mjs with-identity-examples harness
```

This command sends two live TRU messages. Run it when no scan is using the saved conversation.
