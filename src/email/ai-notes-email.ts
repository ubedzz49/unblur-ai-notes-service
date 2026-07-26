// builds the "your AI notes are ready" email -- kept separate from EmailSender so the copy can
// be unit tested without a network dependency
export function buildAiNotesEmail(deliveryId: string, webAppBaseUrl: string): { subject: string; text: string } {
  const link = `${webAppBaseUrl}/ai-notes/${deliveryId}`;
  return {
    subject: "Your AI notes and transcript are ready",
    text: `Your session's AI-generated notes and transcript are ready.\n\nView them here: ${link}\n\nIf you didn't expect this email, you can ignore it.`,
  };
}
