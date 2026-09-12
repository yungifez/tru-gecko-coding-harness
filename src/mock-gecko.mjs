import { GeckoHarness } from "./gecko-harness.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runMockConversation(prompt, { output = console.log } = {}) {
  const harness = new GeckoHarness({ output });
  const messageId = "mock-bot-message-1";
  const answer = `I received your coding task: ${prompt}. Start with a small test, then implement the smallest useful change.`;

  harness.renderEvent({ event: "client-participantTyping", data: { isTyping: true } });
  await wait(120);
  harness.renderEvent({
    event: "client-sendMessage",
    data: { messageId: "mock-user-message-1", entryText: prompt },
  });
  harness.renderEvent({ event: "client-participantTyping", data: { isTyping: false } });
  harness.renderEvent({ event: "botTyping", data: { typing: true } });

  for (const chunk of answer.match(/.{1,18}(?:\s|$)/g) ?? [answer]) {
    await wait(45);
    harness.renderEvent({
      event: "botMessageStreamed",
      data: { messageId, entryText: chunk },
    });
  }

  harness.renderEvent({ event: "botTyping", data: { typing: false } });
  harness.renderEvent({ event: "botMessageStreamCompleted", data: { messageId } });
}
