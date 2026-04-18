import type { FileInfo } from "../file-finder.ts";
import type { DestinationConfig } from "../config.ts";
import { createStaticUploadServerAdapter } from "./static-upload-server.ts";
import { createFilesystemAdapter } from "./filesystem.ts";

/** Result of a single file transfer attempt. */
export interface TransferResult {
	/** Whether the transfer completed successfully. */
	success: boolean;
	/** The source file that was transferred. */
	sourceFile: FileInfo;
	/** Human-readable destination description (URL path or filesystem path). */
	destination: string;
	/** Error message if the transfer failed. */
	error?: string;
	/** Number of bytes transferred. */
	bytesTransferred?: number;
	/** Transfer duration in milliseconds. */
	durationMs?: number;
	/** Number of attempts made (>=1). Only set when retries were requested. */
	attempts?: number;
}

/** Options passed to {@linkcode RelayAdapter.transfer}. */
export interface TransferOptions {
	/** Abort the in-flight transfer. */
	signal?: AbortSignal;
}

/** Result of an adapter preflight check. */
export interface CheckResult {
	/** Whether the destination looks ready to accept transfers. */
	ok: boolean;
	/** Error message when `ok` is false. */
	error?: string;
}

/** Interface for file transfer adapters. */
export interface RelayAdapter {
	/** Human-readable adapter name (e.g. `"filesystem"`, `"static-upload-server"`). */
	readonly name: string;
	/** Transfer a single file to the destination. */
	transfer(file: FileInfo, options?: TransferOptions): Promise<TransferResult>;
	/**
	 * Optional preflight. Called once before any transfers to verify the
	 * destination is reachable / writable. If it fails, the whole run is
	 * aborted without attempting any transfer.
	 */
	check?(): Promise<CheckResult>;
}

/**
 * Create the appropriate {@linkcode RelayAdapter} based on the destination config.
 * Dispatches on `config.adapter` discriminator field.
 */
export function createAdapter(config: DestinationConfig): RelayAdapter {
	switch (config.adapter) {
		case "static-upload-server":
			return createStaticUploadServerAdapter(config);
		case "filesystem":
			return createFilesystemAdapter(config);
		default:
			throw new Error(
				`Unknown adapter: "${(config as { adapter: string }).adapter}"`,
			);
	}
}
