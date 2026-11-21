#!/usr/bin/env node

// npm `bin` entry (`file-relay-install`). Runs the scaffolder unconditionally: a bin
// must never silently do nothing.
import process from "node:process";
import { runInstall } from "./install.ts";

process.exitCode = await runInstall(process.argv.slice(2));
