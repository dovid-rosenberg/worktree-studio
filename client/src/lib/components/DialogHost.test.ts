import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import DialogHost from './DialogHost.svelte';
import { dialogs, uiDialog } from '$lib/stores/dialog.svelte.js';

/*
 * Picking a task has to LOOK like it did something.
 *
 * The select reset itself to the placeholder on change, so the only evidence of choosing a
 * task was a long URL appearing in a different box below — which is why it was reported as
 * "nothing happens when I click an Asana task". The wiring was fine; the feedback was not.
 */
vi.mock('$lib/api.js', () => ({
  api: vi.fn(async (_m: string, path: string) => {
    if (path.endsWith('/sources')) return [{ id: 'asana', label: 'Asana', needsRepo: false }];
    if (path.includes('/items')) {
      return {
        items: [{ title: 'TOTP - MC', subtitle: 'Asana task', url: 'https://app.asana.com/1/x/111' }],
      };
    }
    return {};
  }),
  tokenQuery: () => '',
}));

const ticketField = { type: 'text' as const, label: 'Ticket', value: '', pick: { source: 'tasks' as const } };

describe('the task picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A dialog from a previous test is still at the head of the queue — uiDialog's promise
    // is never settled here — and DialogHost renders only the head.
    dialogs.queue = [];
  });

  it('names the task it chose, and keeps naming it', async () => {
    render(DialogHost);
    uiDialog({ title: 'Edit', fields: [ticketField] });

    const select = await screen.findByLabelText('Pick a task');
    await screen.findByRole('option', { name: /TOTP - MC/ });
    await fireEvent.change(select, { target: { value: 'https://app.asana.com/1/x/111' } });

    // The receipt: the task's NAME, still on screen.
    expect(await screen.findByText('TOTP - MC')).toBeInTheDocument();
    // …and the select is gone, rather than silently snapped back to the placeholder.
    expect(screen.queryByLabelText('Pick a task')).not.toBeInTheDocument();
  });

  it('still writes the URL, because the URL is what gets saved', async () => {
    render(DialogHost);
    uiDialog({ title: 'Edit', fields: [ticketField] });
    const select = await screen.findByLabelText('Pick a task');
    await screen.findByRole('option', { name: /TOTP - MC/ });
    await fireEvent.change(select, { target: { value: 'https://app.asana.com/1/x/111' } });

    expect((screen.getByLabelText('Ticket') as HTMLInputElement).value).toBe('https://app.asana.com/1/x/111');
  });

  it('clearing brings the list back', async () => {
    render(DialogHost);
    uiDialog({ title: 'Edit', fields: [ticketField] });
    const select = await screen.findByLabelText('Pick a task');
    await screen.findByRole('option', { name: /TOTP - MC/ });
    await fireEvent.change(select, { target: { value: 'https://app.asana.com/1/x/111' } });

    (await screen.findByLabelText('Clear the chosen task')).click();
    expect(await screen.findByLabelText('Pick a task')).toBeInTheDocument();
  });

  it('a PASTED url that is not in the list is left alone — the field is the way in', async () => {
    // A task nobody assigned to you, or one from a tracker with no adapter, must still work.
    render(DialogHost);
    uiDialog({ title: 'Edit', fields: [{ ...ticketField, value: 'https://example.com/ticket/9' }] });

    expect(((await screen.findByLabelText('Ticket')) as HTMLInputElement).value).toBe(
      'https://example.com/ticket/9',
    );
    // It is not one of the fetched tasks, so the picker stays available.
    expect(await screen.findByLabelText('Pick a task')).toBeInTheDocument();
  });
});
