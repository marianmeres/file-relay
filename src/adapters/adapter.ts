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
}

/** Interface for file transfer adapters. */
export interface RelayAdapter {
	/** Human-readable adapter name (e.g. `"filesystem"`, `"static-upload-server"`). */
	readonly name: string;
	/** Transfer a single file to the destination. */
	transfer(file: FileInfo): Promise<TransferResult>;
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
