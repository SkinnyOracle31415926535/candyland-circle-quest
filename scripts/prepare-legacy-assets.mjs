import { cp, mkdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = process.cwd();
const app = basename(root);
const target = resolve(root, "public", "legacy");

const assetsByApp = {
  "candyland-circle-quest": [
    "index.html",
    "candyland-storage.js",
    "temporary-data-transfer.js",
    "site.webmanifest",
    "icon.png",
    "favicon-32.png",
    "icon-180.png",
    "icon-192.png",
    "icon-512.png",
  ],
  "color-game": [
    "index.html",
    "color-game-storage.js",
    "temporary-data-transfer.js",
    "site.webmanifest",
    "icon.png",
    "favicon-32.png",
    "icon-180.png",
    "icon-192.png",
    "icon-512.png",
  ],
  "scavenger-hunt-app": [
    "index.html",
    "scavenger-storage.js",
    "temporary-data-transfer.js",
    "manifest.webmanifest",
    "assets",
  ],
};

const assets = assetsByApp[app];
if (!assets) throw new Error(`No legacy bundle is defined for ${app}.`);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(assets.map((asset) => cp(resolve(root, asset), resolve(target, asset), {
  recursive: true,
})));
