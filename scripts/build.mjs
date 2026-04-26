/**
 * build.mjs
 * Copies index.js and lib/server.js into dist/.
 * The dist/index.js references dist/lib/server.js via a relative import
 * (i.e., "./lib/server.js"), so both files must be present under dist/
 * for the published npm package to work.
 */
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const distDir = path.join(projectRoot, "dist");
const distLibDir = path.join(distDir, "lib");

await mkdir(distDir, { recursive: true });
await mkdir(distLibDir, { recursive: true });

// Copy stdio entrypoint
const srcEntry = path.join(projectRoot, "index.js");
const distEntry = path.join(distDir, "index.js");
await copyFile(srcEntry, distEntry);
try { await chmod(distEntry, 0o755); } catch { /* non-POSIX */ }
console.log(`Built ${path.relative(projectRoot, distEntry)}`);

// Copy shared server factory
const srcServer = path.join(projectRoot, "lib", "server.js");
const distServer = path.join(distLibDir, "server.js");
await copyFile(srcServer, distServer);
console.log(`Built ${path.relative(projectRoot, distServer)}`);
