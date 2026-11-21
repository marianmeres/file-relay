import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotifyConfig } from "../src/config.ts";
import {
	buildNotificationMessage,
	type NotifyContext,
	shouldNotify,
} from "../src/notify.ts";
import type { RelayRunResult, RelayStatus } from "../src/relay.ts";

function makeResult(
	status: RelayStatus,
	overrides: Partial<RelayRunResult> = {},
): RelayRunResult {
	return {
		startedAt: "2026-06-26T10:00:00.000Z",
		finishedAt: "2026-06-26T10:00:03.000Z",
		durationMs: 3000,
		filesFound: 0,
		filesAlreadyTransferred: 0,
		transfers: [],
		status,
		success: status === "ok" || status === "idle",
		...overrides,
	};
}

const baseConfig: NotifyConfig = {
	to: "ops@example.com",
	from: "relay@host",
	on: "always",
	subjectPrefix: "[file-relay]",
	attachLog: false,
	smtp: { host: "smtp.example.com", port: 587 },
};

const okCtx: NotifyContext = {
	result: makeResult("ok", {
		transfers: [
			// biome-ignore lint/suspicious/noExplicitAny: a partial TransferResult stub
			{ success: true } as any,
			// biome-ignore lint/suspicious/noExplicitAny: a partial TransferResult stub
			{ success: true } as any,
		],
	}),
	logText: "Starting relay run\n[INFO] done",
	host: "prod-1",
};

test("notify - shouldNotify always returns true for any status", () => {
	for (const s of [
		"ok",
		"idle",
		"partial",
		"failed",
		"preflight-failed",
		"aborted",
	] as RelayStatus[]) {
		assert.ok(shouldNotify("always", { result: makeResult(s), logText: "" }));
	}
	// also for a fatal error
	assert.ok(
		shouldNotify("always", {
			result: null,
			error: new Error("boom"),
			logText: "",
		}),
	);
});

test("notify - shouldNotify failure only fires on abnormal runs", () => {
	assert.deepStrictEqual(
		shouldNotify("failure", { result: makeResult("ok"), logText: "" }),
		false,
	);
	assert.deepStrictEqual(
		shouldNotify("failure", { result: makeResult("idle"), logText: "" }),
		false,
	);
	for (const s of [
		"partial",
		"failed",
		"preflight-failed",
		"aborted",
	] as RelayStatus[]) {
		assert.deepStrictEqual(
			shouldNotify("failure", { result: makeResult(s), logText: "" }),
			true,
			`expected failure trigger for status "${s}"`,
		);
	}
});

test("notify - shouldNotify failure fires on a fatal error", () => {
	assert.ok(
		shouldNotify("failure", {
			result: null,
			error: new Error("boom"),
			logText: "",
		}),
	);
});

test("notify - shouldNotify failure treats a missing result as failure", () => {
	assert.ok(shouldNotify("failure", { result: null, logText: "" }));
});

test("notify - buildNotificationMessage success subject + body", () => {
	const msg = buildNotificationMessage(baseConfig, okCtx);
	assert.deepStrictEqual(msg.to, "ops@example.com");
	assert.deepStrictEqual(msg.from, "relay@host");
	assert.ok(msg.subject.includes("[file-relay]"));
	assert.ok(msg.subject.includes("OK"));
	assert.ok(msg.subject.includes("prod-1"));
	assert.ok(msg.subject.includes("2 transferred"));
	// body carries the captured output + a summary header
	assert.ok((msg.text ?? "").includes("Status:  OK"));
	assert.ok((msg.text ?? "").includes("Host:    prod-1"));
	assert.ok((msg.text ?? "").includes("Starting relay run"));
});

test("notify - buildNotificationMessage error subject uses ERROR + message", () => {
	const msg = buildNotificationMessage(baseConfig, {
		result: null,
		error: new Error("disk gone"),
		logText: "boom trace",
		host: "prod-9",
	});
	assert.ok(msg.subject.includes("ERROR"));
	assert.ok(msg.subject.includes("disk gone"));
	assert.ok((msg.text ?? "").includes("boom trace"));
});

test("notify - buildNotificationMessage failure counts succeeded/failed", () => {
	const msg = buildNotificationMessage(baseConfig, {
		result: makeResult("partial", {
			filesAlreadyTransferred: 5,
			transfers: [
				// biome-ignore lint/suspicious/noExplicitAny: a partial TransferResult stub
				{ success: true } as any,
				// biome-ignore lint/suspicious/noExplicitAny: a partial TransferResult stub
				{ success: false } as any,
			],
		}),
		logText: "",
		host: "h",
	});
	assert.ok(msg.subject.includes("PARTIAL"));
	assert.ok(msg.subject.includes("1 transferred"));
	assert.ok(msg.subject.includes("1 failed"));
	assert.ok(msg.subject.includes("5 skipped"));
});

test("notify - buildNotificationMessage passes through cc/bcc/replyTo", () => {
	const msg = buildNotificationMessage(
		{
			...baseConfig,
			replyTo: "me@host",
			cc: ["a@host", "b@host"],
			bcc: "c@host",
		},
		okCtx,
	);
	assert.deepStrictEqual(msg.replyTo, "me@host");
	assert.deepStrictEqual(msg.cc, ["a@host", "b@host"]);
	assert.deepStrictEqual(msg.bcc, "c@host");
});

test("notify - buildNotificationMessage attachLog adds a .log attachment", () => {
	const msg = buildNotificationMessage({ ...baseConfig, attachLog: true }, okCtx);
	assert.deepStrictEqual(msg.attachments?.length, 1);
	assert.deepStrictEqual(msg.attachments?.[0].filename, "file-relay.log");
	assert.ok(String(msg.attachments?.[0].content ?? "").includes("Starting relay run"));
});

test("notify - buildNotificationMessage with empty log omits the divider", () => {
	const msg = buildNotificationMessage(baseConfig, {
		result: makeResult("idle"),
		logText: "   ",
		host: "h",
	});
	assert.ok(!(msg.text ?? "").includes("-".repeat(60)));
	// no attachment when there is no captured output, even if attachLog is on
	const msg2 = buildNotificationMessage(
		{ ...baseConfig, attachLog: true },
		{ result: makeResult("idle"), logText: "   ", host: "h" },
	);
	assert.deepStrictEqual(msg2.attachments, undefined);
});
