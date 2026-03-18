# API

## Functions

### `loadConfig(path)`

Load, parse, interpolate environment variables, and validate a JSON config file.

**Parameters:**

- `path` (`string`) -- Path to the JSON config file

**Returns:** `Promise<FileRelayConfig>`

**Throws:** `Error` if the file is not valid JSON, validation fails, or referenced env vars are unset.

**Example:**

```typescript
import { loadConfig } from "@marianmeres/file-relay/mod";

const config = await loadConfig("./relay-config.json");
```

---

### `validateConfig(raw)`

Validate a raw object as a `FileRelayConfig`. Useful when constructing config programmatically.

**Parameters:**

- `raw` (`unknown`) -- Raw object to validate

**Returns:** `FileRelayConfig`

**Throws:** `Error` with descriptive message on invalid input.

**Example:**

```typescript
import { validateConfig } from "@marianmeres/file-relay/mod";

const config = validateConfig({
	logDir: "/tmp/logs",
	trackDir: "/tmp/track",
	source: { dir: "/data/backups", glob: "**/*.sql.gz" },
	destination: { adapter: "filesystem", dir: "/mnt/offsite" },
});
```

---

### `findFiles(source)`

Recursively scan a source directory and return matching files, sorted by mtime descending.

**Parameters:**

- `source` (`SourceConfig`) -- Source directory configuration

**Returns:** `Promise<FileInfo[]>`

**Example:**

```typescript
import { findFiles } from "@marianmeres/file-relay/mod";

const files = await findFiles({
	dir: "/data/backups",
	glob: "**/*.sql.gz",
	exclude: ["**/*-latest.sql.gz"],
});
// files[0] is the most recently modified
```

---

### `createTracker(trackDir)`

Create a filesystem-based tracker for deduplication. Stores `.transferred.json` marker files under `trackDir`, mirroring the source directory structure.

**Parameters:**

- `trackDir` (`string`) -- Directory for marker files

**Returns:** `Tracker`

**Example:**

```typescript
import { createTracker } from "@marianmeres/file-relay/mod";

const tracker = createTracker("/var/lib/file-relay/track");
if (!await tracker.isTransferred("daily/backup.sql.gz")) {
	// ... transfer the file ...
	await tracker.markTransferred("daily/backup.sql.gz", {
		transferredAt: new Date().toISOString(),
		sourcePath: "/data/backups/daily/backup.sql.gz",
		sourceSize: 1024,
		destinationInfo: "https://host/backups",
	});
}
```

---

### `createAdapter(config)`

Create a `RelayAdapter` based on the destination config. Dispatches on the `adapter` discriminator field.

**Parameters:**

- `config` (`DestinationConfig`) -- Destination configuration

**Returns:** `RelayAdapter`

**Example:**

```typescript
import { createAdapter } from "@marianmeres/file-relay/mod";

const adapter = createAdapter({
	adapter: "static-upload-server",
	url: "https://files.example.com/backups",
	token: "secret",
});
```

---

### `relay(config, options?)`

Run the file relay: scan source, filter already-transferred files, transfer new files, and record results. Automatically creates a timestamped log file in `config.logDir`.

**Parameters:**

- `config` (`FileRelayConfig`) -- Full relay configuration
- `options` (`RelayOptions`, optional)
  - `options.dryRun` (`boolean`) -- Find files without transferring. Default: `false`
  - `options.clog` (`ClogFn`) -- Logger instance. Default: `createClog("file-relay")`

**Returns:** `Promise<RelayRunResult>`

**Example:**

```typescript
import { loadConfig, relay } from "@marianmeres/file-relay/mod";

const config = await loadConfig("./config.json");
const result = await relay(config, { dryRun: true });
console.log(
	`Found: ${result.filesFound}, Already transferred: ${result.filesAlreadyTransferred}`,
);
```

---

## Types

### `FileRelayConfig`

```typescript
interface FileRelayConfig {
	logDir: string; // Directory for per-run log files
	trackDir: string; // Directory for deduplication markers
	source: SourceConfig;
	destination: DestinationConfig;
}
```

---

### `SourceConfig`

```typescript
interface SourceConfig {
	dir: string; // Base directory (absolute)
	glob?: string; // Glob pattern. Default: "**/*"
	exclude?: string[]; // Exclusion patterns. Default: []
	followSymlinks?: boolean; // Default: false
}
```

---

### `DestinationConfig`

Discriminated union:

```typescript
type DestinationConfig =
	| StaticUploadServerDestination
	| FilesystemCopyDestination;
```

---

### `StaticUploadServerDestination`

```typescript
interface StaticUploadServerDestination {
	adapter: "static-upload-server";
	url: string; // Server URL with project path
	token: string; // Bearer token (supports ${ENV_VAR})
	timeout?: number; // Request timeout in ms. Default: 300000
}
```

---

### `FilesystemCopyDestination`

```typescript
interface FilesystemCopyDestination {
	adapter: "filesystem";
	dir: string; // Target directory (absolute)
}
```

---

### `FileInfo`

```typescript
interface FileInfo {
	path: string; // Absolute path
	relativePath: string; // Relative to source.dir
	name: string; // Basename
	size: number; // Bytes
	mtime: Date; // Modification time
}
```

---

### `TransferResult`

```typescript
interface TransferResult {
	success: boolean;
	sourceFile: FileInfo;
	destination: string; // Human-readable description
	error?: string; // Error message if failed
	bytesTransferred?: number;
	durationMs?: number;
}
```

---

### `RelayRunResult`

```typescript
interface RelayRunResult {
	startedAt: string; // ISO timestamp
	finishedAt: string; // ISO timestamp
	durationMs: number;
	filesFound: number;
	filesAlreadyTransferred: number;
	transfers: TransferResult[];
	success: boolean; // true if all transfers succeeded
}
```

---

### `RelayAdapter`

```typescript
interface RelayAdapter {
	readonly name: string;
	transfer(file: FileInfo): Promise<TransferResult>;
}
```

---

### `Tracker`

```typescript
interface Tracker {
	isTransferred(relativePath: string): Promise<boolean>;
	markTransferred(relativePath: string, meta: TransferMeta): Promise<void>;
}
```

---

### `TransferMeta`

```typescript
interface TransferMeta {
	transferredAt: string; // ISO timestamp
	sourcePath: string; // Absolute path to source file
	sourceSize: number; // Bytes
	destinationInfo: string; // Human-readable description
}
```

---

### `RelayOptions`

```typescript
interface RelayOptions {
	dryRun?: boolean; // Find files without transferring
	clog?: ClogFn; // Logger instance
}
```
