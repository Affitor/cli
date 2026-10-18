import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runInstallWizard } from '../src/lib/wizard';

// Exercise the real wizard and generated advice, without installing packages or using the network.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));

const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function advice(stripeRecordsSales?: true | 'unknown') {
  const cwd = mkdtempSync(join(tmpdir(), 'affitor-wizard-stripe-'));
  dirs.push(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { fastify: '4', stripe: '17' } }));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'server.ts'), "const event = stripe.webhooks.constructEvent(body, signature, secret);\n");
  await runInstallWizard({ cwd, programId: 7, apiUrl: 'http://test.local', autoConfirm: true, stripeRecordsSales });
  expect(spawnSync).toHaveBeenCalledTimes(1);
  return vi.mocked(console.log).mock.calls.flat().join('\n');
}

describe('the real wizard respects the onboarding Stripe mode', () => {
  it.each([true, 'unknown'] as const)('%s prints the lead step without a second sale/refund path', async (mode) => {
    const output = await advice(mode);
    expect(output).toContain('affitor.trackLead(');
    expect(output).not.toContain('affitor.trackSale(');
    expect(output).not.toContain('affitor.trackRefund(');
    expect(output).not.toContain('→ add trackSale');
    expect(output).toContain(mode === true ? 'Do not add a second trackSale' : 'Stripe sale tracking needs review');
  });

  it('keeps the existing standalone init wizard advice when no onboarding mode is supplied', async () => {
    const output = await advice();
    expect(output).toContain('affitor.trackSale(');
    expect(output).toContain('affitor.trackRefund(');
  });
});
