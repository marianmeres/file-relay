import { resolve } from "@std/path";

function printUsage() {
	console.log(`
file-relay install

Scaffold a new file-relay directory with config, env template, and task runner.

Usage:
  deno run -A jsr:@marianmeres/file-relay/install <dirname>

After install:
  1. Edit .env with your credentials
  2. Setup cron: deno task backup
`.trim());
}

function askRequired(question: string): string {
	while (true) {
		const answer = prompt(question);
		if (answer?.trim()) return answer.trim();
		console.log("  Value is required.");
	}
}

function askChoice(question: string, choices: string[], defaultChoice?: string): string {
	const hint = choices.map((c) => (c === defaultChoice ? `[${c}]` : c)).join("/");
	while (true) {
		const answer = prompt(`${question} (${hint})`);
		if (!answer?.trim() && defaultChoice) return defaultChoice;
		if (answer && choices.includes(answer.trim())) return answer.trim();
		console.log(`  Please choose one of: ${choices.join(", ")}`);
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		const stat = await Deno.stat(path);
		return stat.isDirectory;
	} catch {
		return false;
	}
}

async function main() {
	const dirname = Deno.args[0];

	if (!dirname || dirname === "--help" || dirname === "-h") {
		printUsage();
		Deno.exit(dirname ? 0 : 2);
	}

	const targetDir = resolve(dirname);

	if (await dirExists(targetDir)) {
		console.error(`Error: directory already exists: ${targetDir}`);
		Deno.exit(1);
	}

	// Interactive prompts
	const sourceDir = askRequired("Source directory to relay files from:");
	const adapter = askChoice("Destination adapter:", [
		"static-upload-server",
		"filesystem",
	], "static-upload-server");

	let destinationConfig: Record<string, string>;
	let envExample: string;

	if (adapter === "filesystem") {
		const destDir = askRequired("Destination directory (filesystem copy target):");
		destinationConfig = { adapter: "filesystem", dir: destDir };
		envExample = "# No environment variables needed for filesystem adapter\n";
	} else {
		destinationConfig = {
			adapter: "static-upload-server",
			url: "${STATIC_UPLOAD_SERVER_URL}",
			token: "${STATIC_UPLOAD_SERVER_TOKEN}",
		};
		envExample = "STATIC_UPLOAD_SERVER_URL=...\nSTATIC_UPLOAD_SERVER_TOKEN=...\n";
	}

	const configJson = JSON.stringify(
		{
			logDir: "./log",
			trackDir: "./track",
			source: { dir: sourceDir, glob: "**/*" },
			destination: destinationConfig,
		},
		null,
		"\t",
	);

	const denoJson = JSON.stringify(
		{
			tasks: {
				backup:
					"deno run -A --env-file=.env jsr:@marianmeres/file-relay config.json",
			},
		},
		null,
		"\t",
	);

	// Create directory structure
	await Deno.mkdir(resolve(targetDir, "log"), { recursive: true });
	await Deno.mkdir(resolve(targetDir, "track"), { recursive: true });

	await Deno.writeTextFile(resolve(targetDir, "config.json"), configJson + "\n");
	await Deno.writeTextFile(resolve(targetDir, "deno.json"), denoJson + "\n");
	await Deno.writeTextFile(resolve(targetDir, ".env.example"), envExample);
	await Deno.writeTextFile(resolve(targetDir, "log", ".gitkeep"), "");
	await Deno.writeTextFile(resolve(targetDir, "track", ".gitkeep"), "");

	console.log(`\nCreated file-relay instance at: ${targetDir}`);
	console.log(`\nNext steps:`);
	console.log(`  1. cd ${dirname}`);
	console.log(`  2. cp .env.example .env && edit .env`);
	console.log(`  3. Setup cron: deno task backup`);
}

main();
