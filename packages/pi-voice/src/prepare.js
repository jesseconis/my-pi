#!/usr/bin/env node

/**
 * Optional pi-voice config initializer.
 *
 * This script is intentionally opt-in so package installation does not mutate
 * ~/.pi/voice. Run with PI_VOICE_WRITE_DEFAULT_CONFIG=1 to create a config from
 * config/voice-config.example.json when no config exists.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_VOICE_WRITE_DEFAULT_CONFIG !== "1") {
  console.log("pi-voice: config initializer skipped (set PI_VOICE_WRITE_DEFAULT_CONFIG=1 to enable).");
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const CONFIG_DIR = resolve(process.env.PI_VOICE_DIR ?? join(homedir(), ".pi", "voice"));
const CONFIG_FILE = resolve(CONFIG_DIR, "config.json");
const EXAMPLE_CONFIG = resolve(PACKAGE_ROOT, "config", "voice-config.example.json");
const PRONUNCIATION_FILE = resolve(CONFIG_DIR, "pronunciations.json");
const EXAMPLE_PRONUNCIATIONS = resolve(PACKAGE_ROOT, "config", "pronunciations.example.json");

if (existsSync(CONFIG_FILE)) {
  console.log("pi-voice: Configuration file already exists at", CONFIG_FILE);
  process.exit(0);
}

mkdirSync(CONFIG_DIR, { recursive: true });
copyFileSync(EXAMPLE_CONFIG, CONFIG_FILE);
if (!existsSync(PRONUNCIATION_FILE)) {
  copyFileSync(EXAMPLE_PRONUNCIATIONS, PRONUNCIATION_FILE);
}
console.log("pi-voice: Wrote example configuration to", CONFIG_FILE);
