/**
 * @module
 *
 * Email notification for a relay run. A thin operational layer on top of
 * `@marianmeres/send-email`: it turns a {@linkcode RelayRunResult} (plus the
 * captured run output) into a status-summarizing email and sends it via SMTP.
 *
 * This module is imported by the CLI runner only — keeping it out of
 * `@marianmeres/file-relay/mod` means the programmatic API never pulls in an
 * SMTP/nodemailer dependency.
 */

import type { SendOptions } from "@marianmeres/send-email";
import type { NotifyConfig } from "./config.ts";
import type { RelayRunResult, RelayStatus } from "./relay.ts";

/**
 * The outcome of a relay run, as far as notifications care. Either a completed
 * run ({@linkcode RelayRunResult}) or a fatal error thrown before/while running.
 */
export interface NotifyContext {
	/** Structured result, or `null` if the run threw before returning one. */
	result: RelayRunResult | null;
	/** A fatal error if the run threw, else `null`. */
	error?: Error | null;
	/** Captured run output (the lines the CLI logged), used as the email body. */
	logText: string;
	/** Hostname for the subject/body, so a glance identifies the machine. */
	host?: string;
}

/** Statuses that count as "something to worry about" for `on: "failure"`. */
const FAILURE_STATUSES: ReadonlySet<RelayStatus> = new Set<RelayStatus>([
	"failed",
	"partial",
	"preflight-failed",
	"aborted",
]);

/** True when a context represents a failed/abnormal run. */
function isFailure(ctx: NotifyContext): boolean {
	if (ctx.error) return true;
	if (!ctx.result) return true; // no result + no error shouldn't happen; treat as failure
	return FAILURE_STATUSES.has(ctx.result.status);
}

/**
 * Decide whether a run warrants a notification under the configured trigger.
 *
 * @param trigger - `"always"` or `"failure"`.
 * @param ctx - The run outcome.
 * @returns `true` if an email should be sent.
 */
export function shouldNotify(
	trigger: NotifyConfig["on"],
	ctx: NotifyContext,
): boolean {
	if (trigger === "failure") return isFailure(ctx);
	return true; // "always" (and the default)
}

/** Short human label for a status, used in the subject line. */
function statusLabel(ctx: NotifyContext): string {
	if (ctx.error) return "ERROR";
	switch (ctx.result?.status) {
		case "ok":
			return "OK";
		case "idle":
			return "OK (idle)";
		case "partial":
			return "PARTIAL";
		case "failed":
			return "FAILED";
		case "preflight-failed":
			return "PREFLIGHT FAILED";
		case "aborted":
			return "ABORTED";
		default:
			return "UNKNOWN";
	}
}

/** One-line summary of what happened, reused in subject and body header. */
function summaryLine(ctx: NotifyContext): string {
	if (ctx.error) return ctx.error.message;
	const r = ctx.result;
	if (!r) return "no result";
	const transferred = r.transfers.filter((t) => t.success).length;
	const failed = r.transfers.length - transferred;
	const parts = [`${transferred} transferred`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (r.filesAlreadyTransferred > 0) {
		parts.push(`${r.filesAlreadyTransferred} skipped`);
	}
	return parts.join(", ");
}

/**
 * Build the email message (subject + body) for a run. Pure and side-effect
 * free, so it can be unit-tested without an SMTP connection.
 *
 * @param config - The notification config.
 * @param ctx - The run outcome + captured output.
 * @returns A `SendOptions` ready to hand to `@marianmeres/send-email`.
 */
export function buildNotificationMessage(
	config: NotifyConfig,
	ctx: NotifyContext,
): SendOptions {
	const prefix = config.subjectPrefix ?? "[file-relay]";
	const host = ctx.host ?? "unknown-host";
	const label = statusLabel(ctx);
	const summary = summaryLine(ctx);

	const subject = `${prefix} ${label} on ${host} — ${summary}`.trim();

	const headerLines = [
		`Status:  ${label}`,
		`Host:    ${host}`,
		`Summary: ${summary}`,
	];
	if (ctx.result) {
		headerLines.push(
			`Started: ${ctx.result.startedAt}`,
			`Took:    ${(ctx.result.durationMs / 1000).toFixed(1)}s`,
		);
	}

	const body = ctx.logText.trim().length > 0
		? headerLines.join("\n") + "\n\n" + "-".repeat(60) + "\n" +
			ctx.logText.trimEnd() + "\n"
		: headerLines.join("\n") + "\n";

	const message: SendOptions = {
		to: config.to,
		from: config.from,
		subject,
		text: body,
	};
	if (config.replyTo) message.replyTo = config.replyTo;
	if (config.cc) message.cc = config.cc;
	if (config.bcc) message.bcc = config.bcc;
	if (config.attachLog && ctx.logText.trim().length > 0) {
		message.attachments = [{
			filename: "file-relay.log",
			content: ctx.logText,
			contentType: "text/plain",
		}];
	}

	return message;
}

/** Maps {@linkcode NotifyConfig.smtp} onto send-email's `smtp` option. */
function toSmtpOptions(smtp: NotifyConfig["smtp"]) {
	const opts: {
		host: string;
		port: number;
		secure?: boolean;
		auth?: { user: string; pass: string };
		connectionTimeout?: number;
		socketTimeout?: number;
		tls?: { servername?: string; rejectUnauthorized?: boolean };
	} = {
		host: smtp.host,
		port: smtp.port ?? 587,
	};
	if (smtp.secure !== undefined) opts.secure = smtp.secure;
	if (smtp.user !== undefined && smtp.pass !== undefined) {
		opts.auth = { user: smtp.user, pass: smtp.pass };
	}
	if (smtp.connectionTimeout !== undefined) {
		opts.connectionTimeout = smtp.connectionTimeout;
	}
	if (smtp.socketTimeout !== undefined) opts.socketTimeout = smtp.socketTimeout;
	if (smtp.tls !== undefined) opts.tls = smtp.tls;
	return opts;
}

/** The result of a {@linkcode sendNotification} call. */
export interface NotifyResult {
	/** Whether an email was actually sent. */
	sent: boolean;
	/** Why no email was sent (e.g. trigger didn't match), if `sent` is false. */
	skippedReason?: string;
	/** The send error message, if the send was attempted but failed. */
	error?: string;
}

/**
 * Send a notification email for a relay run, honouring the configured trigger.
 *
 * Never throws: a failed send is reported via {@linkcode NotifyResult.error}
 * (and is also a real concern, so callers should surface it) but must not
 * change the relay's own exit code.
 *
 * @param config - The notification config (already validated/normalized).
 * @param ctx - The run outcome + captured output.
 * @returns What happened: sent, skipped, or send-failed.
 */
export async function sendNotification(
	config: NotifyConfig,
	ctx: NotifyContext,
): Promise<NotifyResult> {
	if (!shouldNotify(config.on, ctx)) {
		return { sent: false, skippedReason: `trigger "${config.on}" not met` };
	}

	const message = buildNotificationMessage(config, ctx);
	try {
		// Imported here (not at module load) so the SMTP/nodemailer dependency is
		// pulled only when an email is genuinely being sent.
		const { send } = await import("@marianmeres/send-email");
		await send(message, { smtp: toSmtpOptions(config.smtp) });
		return { sent: true };
	} catch (err) {
		return {
			sent: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
