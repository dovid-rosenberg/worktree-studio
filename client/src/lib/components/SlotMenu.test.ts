import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SlotMenu from './SlotMenu.svelte';

/*
 * The picker's whole job is to stop you choosing a slot that cannot work, and to say why
 * instead of just greying out. Both halves are asserted: disabled, AND carrying the pid
 * or the holding feature, because a disabled row with no reason is the state this
 * feature exists to replace.
 */
const REPORT = [
  {
    slot: 0,
    state: 'blocked',
    ports: { 'accept-blue': [1231] },
    blockedBy: { port: 1231, pid: 54549 },
  },
  { slot: 1, state: 'held', ports: { 'accept-blue': [1331] }, heldBy: 'iso-mfa-totp' },
  { slot: 2, state: 'free', ports: { 'accept-blue': [1431] } },
  { slot: 3, state: 'current', ports: { 'accept-blue': [1531] } },
];

const api = vi.hoisted(() => vi.fn());
vi.mock('$lib/api.js', () => ({ api }));
vi.mock('$lib/errmsg.js', () => ({ errMessage: (e: Error) => e.message }));

/** Open the menu the way a user does, then wait for the fetched rows. */
async function open(props: Record<string, unknown> = {}) {
  api.mockResolvedValue(REPORT);
  render(SlotMenu, { feature: 'f', mode: 'start', onpick: () => {}, ...props });
  (await screen.findByRole('button', { name: /choose a slot/i })).click();
  await screen.findByRole('menuitem', { name: /slot 2/i });
}

describe('SlotMenu', () => {
  it('disables a blocked slot and names the pid holding it', async () => {
    await open();
    const row = screen.getByRole('menuitem', { name: /slot 0/i });
    expect(row).toBeDisabled();
    expect(row.textContent).toMatch(/54549/);
  });

  it('disables a held slot and names the feature holding it', async () => {
    await open();
    const row = screen.getByRole('menuitem', { name: /slot 1/i });
    expect(row).toBeDisabled();
    expect(row.textContent).toMatch(/iso-mfa-totp/);
  });

  it("disables the feature's own slot", async () => {
    await open();
    expect(screen.getByRole('menuitem', { name: /slot 3/i })).toBeDisabled();
  });

  it('shows the ports a free slot would use', async () => {
    await open();
    expect(screen.getByRole('menuitem', { name: /slot 2/i }).textContent).toMatch(/accept-blue 1431/);
  });

  it('calls onpick with the chosen slot', async () => {
    const onpick = vi.fn();
    await open({ onpick });
    screen.getByRole('menuitem', { name: /slot 2/i }).click();
    expect(onpick).toHaveBeenCalledWith(2, expect.objectContaining({ slot: 2 }));
  });

  it('fetches the report per open, not from the topology frame', async () => {
    await open();
    expect(api).toHaveBeenCalledWith('GET', '/api/v1/group/f/slots');
  });

  it('surfaces a failed fetch instead of an empty list', async () => {
    api.mockRejectedValue(new Error('daemon is down'));
    render(SlotMenu, { feature: 'f', mode: 'start', onpick: () => {} });
    (await screen.findByRole('button', { name: /choose a slot/i })).click();
    expect(await screen.findByText(/daemon is down/)).toBeTruthy();
  });

  it('in move mode the trigger is the slot badge', async () => {
    api.mockResolvedValue(REPORT);
    render(SlotMenu, { feature: 'f', mode: 'move', current: 3, onpick: () => {} });
    const badge = await screen.findByRole('button', { name: /change slot/i });
    expect(badge.textContent).toMatch(/slot 3/);
  });
});
