import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const redirects = {
  "auto/index.mjs": pathToFileURL(path.join(__dirname, "our-auto-index.ts")).href,
  "build/esm/lib/FakeEvent.js": pathToFileURL(path.join(__dirname, "our-fake-event.ts")).href,
  "build/esm/lib/errors.js": pathToFileURL(path.join(__dirname, "our-errors.ts")).href,
};

export function resolve(specifier, context, nextResolve) {
  for (const [pattern, target] of Object.entries(redirects)) {
    if (specifier.includes(pattern)) {
      return { url: target, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
