/**
 * Derived-image Dockerfile rendering for per-agent-group package installs.
 *
 * Split out of `container-runner.ts` purely so it can be tested: that module
 * pulls in the DB, OneCLI, and the session manager, so asserting on
 * generated Dockerfile text in place would mean mocking half the host. This is
 * a pure function over two string lists.
 *
 * Everything interpolated here runs **as root at image-build time on the
 * host**, so `assertValidPackageLists` guards the entry. That check is not
 * redundant with the CLI's: `container.json`, `local.jsonc`, and
 * `default.jsonc` all feed `stored.packages` without passing through a
 * command, and none of them get runtime schema validation.
 */
import { assertValidPackageLists } from './package-specs.js';

export function renderAgentGroupDockerfile(baseImage: string, aptPackages: string[], npmPackages: string[]): string {
  assertValidPackageLists({ apt: aptPackages, npm: npmPackages });

  let dockerfile = `FROM ${baseImage}\nUSER root\n`;

  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }

  if (npmPackages.length > 0) {
    const pnpmPackages = npmPackages.filter((p) => !p.startsWith('github:'));
    const bunPackages = npmPackages.filter((p) => p.startsWith('github:'));
    if (pnpmPackages.length > 0) {
      // pnpm skips build scripts unless packages are allowlisted. Append each
      // to /root/.npmrc (base image sets it up for agent-browser) so packages
      // with postinstall — e.g. playwright, puppeteer, native addons — don't
      // install silently broken.
      const allowlist = pnpmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
      dockerfile += `RUN ${allowlist} && pnpm install -g ${pnpmPackages.join(' ')}\n`;
    }
    if (bunPackages.length > 0) {
      // Bun globals (e.g. github:owner/repo). An npm registry name is a
      // different package — use the github: spec. Symlink bins into /usr/local/bin
      // so the `node` user and MCP stdio spawns find them on PATH.
      dockerfile +=
        `RUN export BUN_INSTALL=/usr/local/bun && mkdir -p "$BUN_INSTALL" && ` +
        `bun install -g ${bunPackages.join(' ')} && ` +
        `for f in "$BUN_INSTALL/bin"/*; do [ -e "$f" ] && ln -sf "$f" /usr/local/bin/; done\n`;
    }
  }

  dockerfile += 'USER node\n';
  return dockerfile;
}
