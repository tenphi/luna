import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ running: false, label: '', exec: vi.fn() }));
vi.mock('child_process', () => ({ execSync: fixture.exec }));
vi.mock('fs', () => ({ default: { existsSync: () => true } }));
vi.mock('os', () => ({ default: { platform: () => 'darwin', homedir: () => '/fixture' } }));
vi.mock('../host-mcp/builtins/apple/shared/app-bundle.js', () => ({
  ensureLaunchdPlistUsesAppBundle: () => ({ rewritten: false }),
}));

import { getLaunchdLabel } from '../install-slug.js';
import { restartService } from './host-service.js';

beforeEach(() => {
  fixture.running = false;
  fixture.label = getLaunchdLabel('/fixture/Luna');
  fixture.exec.mockReset().mockImplementation((command: string) => {
    if (command === 'launchctl list') return fixture.running ? `123\t0\t${fixture.label}\n` : '';
    if (command.startsWith('launchctl kickstart')) fixture.running = true;
    return '';
  });
});

it('reloads an unloaded installed service when redeploy follows an offline database upgrade', () => {
  const result = restartService('/fixture/Luna');
  const commands = fixture.exec.mock.calls.map(([command]) => command as string);
  expect(commands.findIndex((command) => command.startsWith('launchctl load'))).toBeLessThan(
    commands.findIndex((command) => command.startsWith('launchctl kickstart')),
  );
  expect(commands.some((command) => command.startsWith('launchctl load'))).toBe(true);
  expect(result.state).toBe('running');
  expect(result.pid).toBe(123);
});
