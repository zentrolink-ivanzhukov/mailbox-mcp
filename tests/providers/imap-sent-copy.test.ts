import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ImapProvider, smtpHostSavesSent, stripBccHeader, ensureMessageHeaders,
} from "../../src/providers/imap.js";

function mocks() {
  const imap = {
    list: vi.fn().mockResolvedValue([
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Sent", specialUse: "\\Sent" },
      { path: "INBOX.Sent" },
      { path: "Drafts", specialUse: "\\Drafts" },
    ]),
    search: vi.fn().mockResolvedValue([]),
    append: vi.fn().mockResolvedValue({ uid: 1 }),
    fetchOne: vi.fn(),
    download: vi.fn().mockResolvedValue(undefined),
    messageDelete: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    on: vi.fn(),
  };
  const smtp = { sendMail: vi.fn().mockImplementation(async (m: any) => ({ messageId: m.messageId })) };
  return { imap, smtp };
}

describe("ImapProvider: copy of sent mail in Sent", () => {
  let imap: ReturnType<typeof mocks>["imap"];
  let smtp: ReturnType<typeof mocks>["smtp"];
  let provider: ImapProvider;

  beforeEach(() => {
    ({ imap, smtp } = mocks());
    provider = new ImapProvider(imap as any, smtp as any, "me@example.org");
  });

  it("sendMessage appends the same message (same Message-ID, Bcc kept) to the SPECIAL-USE Sent folder as \\Seen", async () => {
    const id = await provider.sendMessage(["to@x.test"], "Привет", "Тело письма", { bcc: ["hidden@x.test"] });
    const sent = smtp.sendMail.mock.calls[0][0];
    expect(sent.messageId).toMatch(/^<[0-9a-f-]+@example\.org>$/);
    expect(id).toBe(sent.messageId);

    expect(imap.getMailboxLock).toHaveBeenCalledWith("Sent");
    expect(imap.search).toHaveBeenCalledWith({ header: { "message-id": sent.messageId } }, { uid: true });
    expect(imap.append).toHaveBeenCalledTimes(1);
    const [folder, raw, flags, date] = imap.append.mock.calls[0];
    expect(folder).toBe("Sent");
    expect(flags).toEqual(["\\Seen"]);
    expect(date).toBe(sent.date);
    const text = (raw as Buffer).toString();
    expect(text).toContain(`Message-ID: ${sent.messageId}`);
    expect(text).toMatch(/^Bcc: hidden@x\.test/m);
    expect(text).toMatch(/^To: to@x\.test/m);
  });

  it("does not append when Sent already holds the Message-ID (server filed it itself)", async () => {
    imap.search.mockResolvedValue([42]);
    const id = await provider.sendMessage(["to@x.test"], "s", "b");
    expect(imap.append).not.toHaveBeenCalled();
    expect(id).not.toContain("NOT saved");
  });

  it("saveSentCopy: false skips the copy entirely", async () => {
    provider = new ImapProvider(imap as any, smtp as any, "me@example.org", { saveSentCopy: false });
    await provider.sendMessage(["to@x.test"], "s", "b");
    expect(imap.list).not.toHaveBeenCalled();
    expect(imap.append).not.toHaveBeenCalled();
  });

  it("a failed append does not fail the send, but says so in the returned id", async () => {
    imap.append.mockRejectedValue(new Error("TRYCREATE"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await provider.sendMessage(["to@x.test"], "s", "b");
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(id).toContain("copy was NOT saved to Sent: TRYCREATE");
    spy.mockRestore();
  });

  it("replyToMessage also files a copy carrying In-Reply-To", async () => {
    imap.fetchOne.mockResolvedValue({
      uid: 7,
      envelope: { from: [{ address: "s@x" }], to: [], subject: "Hi", date: new Date(0), messageId: "<orig@x>" },
      flags: new Set(), bodyStructure: undefined, headers: Buffer.from("\r\n"),
    });
    await provider.replyToMessage("INBOX:7", "thanks");
    const raw = (imap.append.mock.calls[0][1] as Buffer).toString();
    expect(imap.append.mock.calls[0][0]).toBe("Sent");
    expect(raw).toContain("In-Reply-To: <orig@x>");
  });

  it("sendDraft: adds Message-ID/Date, strips Bcc on the wire, keeps it in the Sent copy, deletes the draft", async () => {
    const draft = Buffer.from(
      "From: me@example.org\r\nTo: to@x.test\r\nBcc: hidden@x.test,\r\n other@x.test\r\nSubject: s\r\n\r\nbody\r\n",
    );
    imap.fetchOne.mockResolvedValue({
      source: draft,
      envelope: { to: [{ address: "to@x.test" }], bcc: [{ address: "hidden@x.test" }, { address: "other@x.test" }] },
    });
    smtp.sendMail.mockResolvedValue({ messageId: undefined });

    const id = await provider.sendDraft("Drafts:5");
    const wire = smtp.sendMail.mock.calls[0][0];
    expect(wire.bcc).toBe("hidden@x.test, other@x.test");
    const wireText = (wire.raw as Buffer).toString();
    expect(wireText).not.toMatch(/bcc|other@x\.test/i);
    expect(wireText).toMatch(/^Message-ID: <[^>]+@example\.org>\r\n/);
    expect(wireText).toMatch(/^Date: /m);

    const [folder, copy, flags] = imap.append.mock.calls[0];
    expect(folder).toBe("Sent");
    expect(flags).toEqual(["\\Seen"]);
    expect((copy as Buffer).toString()).toContain("Bcc: hidden@x.test,\r\n other@x.test");
    expect(id).toMatch(/^<[^>]+@example\.org>$/);
    expect(imap.messageDelete).toHaveBeenCalledWith(5, { uid: true });
  });
});

describe("raw header helpers", () => {
  it("stripBccHeader leaves body bytes untouched (non-UTF-8 charset)", () => {
    const body = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    const raw = Buffer.concat([Buffer.from("To: a@x\r\nBcc: b@x\r\nSubject: s\r\n\r\n"), body]);
    const out = stripBccHeader(raw);
    expect(out.subarray(out.length - body.length).equals(body)).toBe(true);
    expect(out.toString("latin1")).toBe("To: a@x\r\nSubject: s\r\n\r\n" + body.toString("latin1"));
  });

  it("stripBccHeader handles Bcc as the last header line and LF-only messages", () => {
    expect(stripBccHeader(Buffer.from("To: a@x\nBcc: b@x\n\nbody")).toString()).toBe("To: a@x\n\nbody");
    const same = Buffer.from("To: a@x\r\n\r\nBcc: not-a-header\r\n");
    expect(stripBccHeader(same)).toBe(same);
  });

  it("ensureMessageHeaders keeps an existing Message-ID and Date", () => {
    const raw = Buffer.from("Message-ID:\r\n <keep@x>\r\nDate: Thu, 01 Jan 2026 00:00:00 +0000\r\n\r\nb");
    const r = ensureMessageHeaders(raw, () => "<new@x>");
    expect(r.messageId).toBe("<keep@x>");
    expect(r.raw).toBe(raw);
  });

  it("smtpHostSavesSent: Gmail/Outlook yes, mailcow and the rest no", () => {
    expect(smtpHostSavesSent("smtp.gmail.com")).toBe(true);
    expect(smtpHostSavesSent("smtp.office365.com")).toBe(true);
    expect(smtpHostSavesSent("smtp-mail.outlook.com")).toBe(true);
    expect(smtpHostSavesSent("mail.newreality.cc")).toBe(false);
    expect(smtpHostSavesSent("mail.zentrolink.de")).toBe(false);
    expect(smtpHostSavesSent("smtp.yandex.com")).toBe(false);
    expect(smtpHostSavesSent("notgmail.com.evil.test")).toBe(false);
  });
});
