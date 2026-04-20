import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const srcEntry = path.join(projectRoot, "index.js");
const distDir = path.join(projectRoot, "dist");
const distEntry = path.join(distDir, "index.js");

await mkdir(distDir, { recursive: true });
await copyFile(srcEntry, distEntry);

try {
    await chmod(distEntry, 0o755);
} catch {
    // Non-POSIX filesystems may not support chmod; safe to ignore.
}

console.log(`Built ${path.relative(projectRoot, distEntry)}`);
