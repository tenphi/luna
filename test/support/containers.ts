import { vi } from 'vitest';

/** Simulate the container boundary without starting processes or contacting host services. */
export function fakeContainers() {
  const methods = [
    'wakeContainer',
    'buildAgentGroupImage',
    'isContainerRunning',
    'getActiveContainerCount',
    'killContainer',
  ];
  return Object.fromEntries(
    methods.map((name) => {
      const method = vi.fn();
      if (name === 'wakeContainer') method.mockResolvedValue(true);
      else if (name === 'buildAgentGroupImage') method.mockResolvedValue(undefined);
      else if (name === 'isContainerRunning') method.mockReturnValue(false);
      else if (name === 'getActiveContainerCount') method.mockReturnValue(0);
      return [name, method];
    }),
  );
}
