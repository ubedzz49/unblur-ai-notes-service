import sgMail from "@sendgrid/mail";
import { EmailSender } from "./sender.js";

export class SendgridEmailSender implements EmailSender {
  private fromEmail: string;

  constructor() {
    const apiKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.SENDGRID_FROM_EMAIL;
    if (!apiKey) throw new Error("SENDGRID_API_KEY is not set");
    if (!fromEmail) throw new Error("SENDGRID_FROM_EMAIL is not set");

    sgMail.setApiKey(apiKey);
    this.fromEmail = fromEmail;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await sgMail.send({ to, from: this.fromEmail, subject, text });
  }
}
