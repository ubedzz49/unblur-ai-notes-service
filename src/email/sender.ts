export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

// test-only -- captures what would have been sent instead of hitting a real provider
export class RecordingEmailSender implements EmailSender {
  sent: { to: string; subject: string; text: string }[] = [];

  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
  }
}
