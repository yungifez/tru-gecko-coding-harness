export function titleFromFirstQuestion(value) {
  const title = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!title) return "Untitled session";
  return title.length > 64 ? `${title.slice(0, 61).trimEnd()}…` : title;
}

export function ensureSessionTitle(session, firstQuestion) {
  if (!session.title && firstQuestion) {
    session.title = titleFromFirstQuestion(firstQuestion);
    return true;
  }
  return false;
}
