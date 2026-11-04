import { describe, expect, it } from 'vitest';
import { chatOpen, initialPanel, reduce, type Panel, type PanelEvent, type Status } from '../src/entrypoints/sidepanel/state';
import type { PanelState } from '../src/lib/messages';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

const workerState = (state: Partial<PanelState> = {}): PanelEvent => ({
  type: 'state',
  state: { keyEnding: '1234', modelId: HAIKU, level: 'short', scope: 'page', chat: [], videoExcluded: false, ...state },
});
const delta = (text: string): PanelEvent => ({ type: 'delta', stream: 'summary', text });
const chatDelta = (text: string): PanelEvent => ({ type: 'delta', stream: 'chat', text });
const done = (status: 'complete' | 'incomplete', stream: 'summary' | 'chat' = 'summary'): PanelEvent => ({ type: 'done', stream, status });
const failed = (kind: Extract<PanelEvent, { type: 'error' }>['kind'], stream?: 'summary' | 'chat'): PanelEvent => ({
  type: 'error',
  kind,
  ...(stream && { stream }),
});
const requested = (request: Extract<PanelEvent, { type: 'requested' }>['request']): PanelEvent => ({ type: 'requested', request });

const run = (...events: PanelEvent[]) => events.reduce(reduce, initialPanel);

/** Open with a saved key and no stored summary: the panel starts a summary. */
const waiting = () => run(workerState(), requested({ type: 'summarize' }));
const streaming = () => reduce(waiting(), delta('- Plants'));
const complete = () => reduce(streaming(), done('complete'));

const reach: Record<Status, () => Panel> = {
  needsKey: () => run(workerState({ keyEnding: undefined })),
  newPage: () => reduce(complete(), { type: 'navigated' }),
  ready: () => run(workerState({ confirmTokens: 500_000 }), { type: 'cancel' }),
  confirmLong: () => reduce(waiting(), workerState({ confirmTokens: 500_000 })),
  waiting,
  streaming,
  complete,
  incomplete: () => reduce(streaming(), done('incomplete')),
  noContent: () => reduce(waiting(), failed('noContent', 'summary')),
  error: () => reduce(waiting(), failed('rate', 'summary')),
};

describe('panel state', () => {
  it.each(Object.entries(reach))('reaches %s', (status, panel) => {
    expect(panel().status).toBe(status);
  });

  describe('first open', () => {
    it('asks for a key when none is saved', () => {
      expect(run(workerState({ keyEnding: undefined }))).toMatchObject({ status: 'needsKey', startPending: false });
    });

    it('starts a summary when a key is saved and nothing is stored', () => {
      expect(run(workerState())).toMatchObject({ status: 'waiting', startPending: true });
    });

    it('stops asking to start once the summary is requested', () => {
      expect(waiting().startPending).toBe(false);
    });

    it('restores the stored summary and chat with no new request', () => {
      const chat = [{ role: 'user' as const, text: 'Hi' }, { role: 'assistant' as const, text: 'Hello' }];
      const panel = run(workerState({ summary: { text: 'Kept', status: 'complete' }, summaryModelId: HAIKU, chat }));
      expect(panel).toMatchObject({ status: 'complete', summary: { text: 'Kept', modelId: HAIKU }, chat, startPending: false });
    });

    it('restores a stored partial summary as incomplete', () => {
      expect(run(workerState({ summary: { text: 'Part', status: 'incomplete' } })).status).toBe('incomplete');
    });

    it('restores a stored refusal as a refusal, with its text kept', () => {
      const panel = run(workerState({ summary: { text: 'Some', status: 'refused' } }));
      expect(panel).toMatchObject({ status: 'error', error: { kind: 'refused' }, summary: { text: 'Some' } });
    });

    it('treats a stored refusal with no text as no summary', () => {
      expect(run(workerState({ summary: { text: '', status: 'refused' } }))).toMatchObject({ status: 'waiting', startPending: true });
    });

    it('shows the video tag the worker reports', () => {
      expect(run(workerState({ videoExcluded: true })).videoExcluded).toBe(true);
    });
  });

  describe('key setup', () => {
    it('starts the requested summary after a valid save', () => {
      const panel = reach.needsKey();
      const saved = [requested({ type: 'saveKey', key: 'k' }), workerState()].reduce(reduce, panel);
      expect(saved).toMatchObject({ status: 'waiting', startPending: true });
    });

    it('stays on key setup and shows why when a save fails', () => {
      const panel = reduce(reach.needsKey(), failed('auth'));
      expect(panel).toMatchObject({ status: 'needsKey', error: { kind: 'auth' } });
    });

    it('clears the save error on the next try', () => {
      const panel = [failed('auth'), requested({ type: 'saveKey', key: 'k' })].reduce(reduce, reach.needsKey());
      expect(panel.error).toBeUndefined();
    });

    it('returns to key setup when the key is deleted', () => {
      const panel = [requested({ type: 'deleteKey' }), workerState({ keyEnding: undefined })].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'needsKey', summary: undefined, chat: [] });
    });

    it.each(['summary', 'chat'] as const)('returns to key setup when the %s stream finds no key', (stream) => {
      expect(reduce(complete(), failed('noKey', stream)).status).toBe('needsKey');
    });
  });

  describe('long page', () => {
    it('asks first when the page is over the model limit', () => {
      expect(reach.confirmLong()).toMatchObject({ status: 'confirmLong', confirmTokens: 500_000 });
    });

    it('waits again on Continue', () => {
      const panel = reduce(reach.confirmLong(), requested({ type: 'summarize', confirmed: true }));
      expect(panel).toMatchObject({ status: 'waiting', confirmTokens: undefined });
    });

    it('offers Sum it up on Cancel', () => {
      expect(reduce(reach.confirmLong(), { type: 'cancel' })).toMatchObject({ status: 'ready', confirmTokens: undefined });
    });

    it('waits on Sum it up from ready', () => {
      expect(reduce(reach.ready(), requested({ type: 'summarize' })).status).toBe('waiting');
    });
  });

  describe('a summary run', () => {
    it('streams from the first text', () => {
      expect(streaming()).toMatchObject({ status: 'streaming', summary: { text: '- Plants', modelId: HAIKU } });
    });

    it('adds each later piece of text', () => {
      expect(reduce(streaming(), delta(' grow')).summary?.text).toBe('- Plants grow');
    });

    it('completes when the worker finishes', () => {
      expect(complete()).toMatchObject({ status: 'complete', summary: { text: '- Plants' } });
    });

    it('keeps the text as incomplete on Stop, panel close, or cut off', () => {
      expect(reach.incomplete()).toMatchObject({ status: 'incomplete', summary: { text: '- Plants' } });
    });

    it('keeps the text as incomplete when the stream is cut off', () => {
      expect(reduce(streaming(), failed('cutoff', 'summary'))).toMatchObject({
        status: 'incomplete',
        summary: { text: '- Plants' },
        error: undefined,
      });
    });

    it('goes to ready when stopped before any text', () => {
      expect(reduce(waiting(), done('incomplete'))).toMatchObject({ status: 'ready', summary: undefined });
    });

    it.each(['restricted', 'noContent'] as const)('shows no content for %s', (kind) => {
      expect(reduce(waiting(), failed(kind, 'summary'))).toMatchObject({ status: 'noContent', error: { kind } });
    });

    it.each(['auth', 'rate', 'unavailable', 'offline', 'cutoff', 'modelGone', 'rejected', 'refused'] as const)(
      'shows the %s failure when nothing arrived',
      (kind) => {
        expect(reduce(waiting(), failed(kind, 'summary'))).toMatchObject({ status: 'error', error: { kind } });
      },
    );

    it('keeps the text on screen when the provider refuses mid-stream', () => {
      expect(reduce(streaming(), failed('refused', 'summary'))).toMatchObject({
        status: 'error',
        error: { kind: 'refused' },
        summary: { text: '- Plants' },
      });
    });

    it('treats an unexpected worker failure like a summary failure', () => {
      expect(reduce(waiting(), failed('unavailable'))).toMatchObject({ status: 'error', error: { kind: 'unavailable' } });
    });

    it.each(['incomplete', 'error'] as const)('waits again on Retry from %s', (status) => {
      const panel = reduce(reach[status](), requested({ type: 'retry' }));
      expect(panel).toMatchObject({ status: 'waiting', summary: undefined, error: undefined });
    });

    it('stays waiting when the worker reports the source before the first text', () => {
      const panel = reduce(waiting(), workerState({ videoExcluded: true }));
      expect(panel).toMatchObject({ status: 'waiting', videoExcluded: true, startPending: false });
    });

    it('waits on a level change and remembers the level', () => {
      const panel = reduce(complete(), requested({ type: 'setLevel', level: 'medium' }));
      expect(panel).toMatchObject({ status: 'waiting', summary: undefined, settings: { level: 'medium' } });
    });

    it('shows a cached summary for the new level at once', () => {
      const panel = [requested({ type: 'setLevel', level: 'medium' }), workerState({ level: 'medium', summary: { text: 'Cached', status: 'complete' } })].reduce(
        reduce,
        complete(),
      );
      expect(panel).toMatchObject({ status: 'complete', summary: { text: 'Cached' } });
    });

    it('keeps a level change during chat', () => {
      const panel = reduce(complete(), requested({ type: 'setLevel', level: 'eli5' }));
      expect(panel.chat).toEqual(complete().chat);
    });
  });

  describe('a failure after a summary was on screen', () => {
    const chat = [{ role: 'user' as const, text: 'Q' }, { role: 'assistant' as const, text: 'A' }];
    const withChat = () => run(workerState({ summary: { text: '- Old', status: 'complete' }, chat }));

    it('brings the summary and chat back with the failure above them after a level change', () => {
      const panel = [requested({ type: 'setLevel', level: 'medium' }), failed('rate', 'summary')].reduce(reduce, withChat());
      expect(panel).toMatchObject({ status: 'complete', summary: { text: '- Old' }, chat, error: { kind: 'rate' }, hidden: undefined });
      expect(chatOpen(panel)).toBe(true);
    });

    it('brings back Incomplete text when Retry fails', () => {
      const panel = [requested({ type: 'retry' }), failed('offline', 'summary')].reduce(reduce, reach.incomplete());
      expect(panel).toMatchObject({ status: 'incomplete', summary: { text: '- Plants' }, error: { kind: 'offline' } });
    });

    it('brings back the summary when the switched model fails', () => {
      const panel = [requested({ type: 'summarize' }), failed('unavailable', 'summary')].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'complete', summary: { text: '- Plants', modelId: HAIKU }, error: { kind: 'unavailable' } });
    });

    it('brings back a page that cannot be read as a failure over the summary', () => {
      const panel = [requested({ type: 'retry' }), failed('restricted', 'summary')].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'complete', error: { kind: 'restricted' } });
    });

    it('brings back stopped text as Incomplete when a level change during the stream fails', () => {
      const panel = [requested({ type: 'setLevel', level: 'eli5' }), failed('rate', 'summary')].reduce(reduce, streaming());
      expect(panel).toMatchObject({ status: 'incomplete', summary: { text: '- Plants' } });
    });

    it('keeps refused text closed to chat when it comes back', () => {
      const refused = run(workerState({ summary: { text: '- Some', status: 'refused' } }));
      const panel = [requested({ type: 'summarize' }), failed('rate', 'summary')].reduce(reduce, refused);
      expect(panel).toMatchObject({ status: 'error', summary: { text: '- Some' }, error: { kind: 'rate' } });
      expect(chatOpen(panel)).toBe(false);
    });

    it('keeps the summary out of sight across a second request', () => {
      const panel = [requested({ type: 'retry' }), requested({ type: 'retry' }), failed('rate', 'summary')].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'complete', summary: { text: '- Plants' } });
    });

    it('keeps the summary out of sight across a model switch while waiting', () => {
      const panel = [requested({ type: 'retry' }), workerState({ modelId: SONNET }), failed('rate', 'summary')].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'complete', summary: { text: '- Plants' } });
    });

    it('does not bring a selection summary back after a whole page request', () => {
      const selection = run(workerState({ scope: 'selection', summary: { text: 'Sel', status: 'complete' } }));
      const panel = [requested({ type: 'summarize', wholePage: true }), failed('rate', 'summary')].reduce(reduce, selection);
      expect(panel).toMatchObject({ status: 'error', summary: undefined });
    });

    it('replaces the old summary once new text arrives', () => {
      const panel = [requested({ type: 'retry' }), delta('New'), failed('refused', 'summary')].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'error', summary: { text: 'New' }, hidden: undefined });
    });

    it('offers a fresh start when stopped before new text', () => {
      const panel = [requested({ type: 'setLevel', level: 'medium' }), done('incomplete')].reduce(reduce, complete());
      expect(panel).toMatchObject({ status: 'ready', summary: undefined, hidden: undefined });
    });
  });

  describe('model switch', () => {
    it('keeps the summary and the model that wrote it', () => {
      const panel = [requested({ type: 'setModel', modelId: SONNET }), workerState({ modelId: SONNET, summary: { text: '- Plants', status: 'complete' }, summaryModelId: HAIKU })].reduce(
        reduce,
        complete(),
      );
      expect(panel).toMatchObject({ status: 'complete', settings: { modelId: SONNET }, summary: { modelId: HAIKU } });
    });

    it('changes only the settings while a summary streams', () => {
      const panel = reduce(streaming(), workerState({ modelId: SONNET, summary: { text: 'Older', status: 'incomplete' } }));
      expect(panel).toMatchObject({ status: 'streaming', settings: { modelId: SONNET }, summary: { text: '- Plants', modelId: HAIKU } });
    });

    it('stays waiting when the switch comes before the first text', () => {
      expect(reduce(waiting(), workerState({ modelId: SONNET }))).toMatchObject({ status: 'waiting', startPending: false });
    });

    it.each(['error', 'noContent'] as const)('keeps the %s message when the model changes or the worker reconnects', (status) => {
      const before = reach[status]();
      const panel = [{ type: 'disconnected' } as const, workerState({ modelId: SONNET })].reduce(reduce, before);
      expect(panel).toMatchObject({ status, error: before.error, settings: { modelId: SONNET } });
    });

    it('keeps the current view when no summary is stored', () => {
      expect(reduce(reach.noContent(), workerState({ modelId: SONNET }))).toMatchObject({ status: 'noContent', settings: { modelId: SONNET } });
    });
  });

  describe('navigation', () => {
    it('stays on key setup, since there is no key to summarize with', () => {
      const panel = reach.needsKey();
      expect(reduce(panel, { type: 'navigated' })).toBe(panel);
    });

    it.each((Object.keys(reach) as Status[]).filter((status) => status !== 'needsKey'))('goes to new page from %s', (status) => {
      const panel = reduce(reach[status](), { type: 'navigated' });
      expect(panel).toMatchObject({ status: 'newPage', summary: undefined, chat: [], error: undefined, reply: undefined });
    });

    it('goes to new page before the first state', () => {
      expect(run({ type: 'navigated' }).status).toBe('newPage');
    });

    it('returns to page scope', () => {
      const selection = run(workerState({ scope: 'selection', summary: { text: 'Sel', status: 'complete' } }));
      expect(reduce(selection, { type: 'navigated' }).settings?.scope).toBe('page');
    });

    it('waits on Sum it up from new page', () => {
      expect(reduce(reach.newPage(), requested({ type: 'summarize' })).status).toBe('waiting');
    });

    it('makes no request of its own on a later state', () => {
      expect(reduce(reach.newPage(), workerState()).startPending).toBe(false);
    });
  });

  describe('scope', () => {
    it('clears chat and returns to the page on Summarize whole page', () => {
      const selection = run(
        workerState({ scope: 'selection', chat: [{ role: 'user', text: 'Q' }], summary: { text: 'Sel', status: 'complete' } }),
      );
      const panel = reduce(selection, requested({ type: 'summarize', wholePage: true }));
      expect(panel).toMatchObject({ status: 'waiting', chat: [], settings: { scope: 'page' } });
    });

    it('waits for the selection summary the worker starts after "More"', () => {
      const panel = reduce(complete(), workerState({ scope: 'selection' }));
      expect(panel).toMatchObject({ status: 'waiting', summary: undefined, startPending: false, settings: { scope: 'selection' } });
    });

    it('keeps the selection scope on a plain summarize', () => {
      const selection = run(workerState({ scope: 'selection' }));
      expect(reduce(selection, requested({ type: 'summarize' })).settings?.scope).toBe('selection');
    });
  });

  describe('chat', () => {
    const asked = () => reduce(complete(), requested({ type: 'chat', text: 'Why?' }));

    it('shows the question at once and waits for the answer', () => {
      expect(asked()).toMatchObject({ chat: [{ role: 'user', text: 'Why?' }], reply: '' });
    });

    it('streams the answer, then adds it to the chat', () => {
      const panel = [chatDelta('Because'), chatDelta(' light'), done('complete', 'chat')].reduce(reduce, asked());
      expect(panel).toMatchObject({
        reply: undefined,
        chat: [{ role: 'user', text: 'Why?' }, { role: 'assistant', text: 'Because light' }],
      });
    });

    it('keeps no empty answer when stopped before any text', () => {
      expect(reduce(asked(), done('incomplete', 'chat')).chat).toEqual([{ role: 'user', text: 'Why?' }]);
    });

    it('keeps the summary and offers the question again when the answer fails', () => {
      const panel = reduce(asked(), failed('rate', 'chat'));
      expect(panel).toMatchObject({
        status: 'complete',
        summary: { text: '- Plants' },
        chat: [],
        reply: undefined,
        error: { kind: 'rate', stream: 'chat', question: 'Why?' },
      });
    });

    it('keeps a partial answer when the answer fails midway', () => {
      const panel = [chatDelta('Part'), failed('cutoff', 'chat')].reduce(reduce, asked());
      expect(panel.chat).toEqual([{ role: 'user', text: 'Why?' }, { role: 'assistant', text: 'Part' }]);
      expect(panel.error).toEqual({ kind: 'cutoff', stream: 'chat' });
    });

    it('keeps the summary when a non-chat failure comes after it', () => {
      expect(reduce(complete(), failed('unavailable'))).toMatchObject({ status: 'complete', error: { kind: 'unavailable' } });
    });

    it('shows a chat answer that arrives with no question pending', () => {
      expect(reduce(complete(), chatDelta('Late')).reply).toBe('Late');
    });

    it('keeps the answer on screen when a state arrives mid-answer', () => {
      const panel = [chatDelta('Part'), workerState({ modelId: SONNET })].reduce(reduce, asked());
      expect(panel).toMatchObject({ reply: 'Part', chat: [{ role: 'user', text: 'Why?' }] });
    });

    it.each([
      ['complete', true],
      ['incomplete', true],
      ['streaming', false],
      ['waiting', false],
      ['error', false],
      ['needsKey', false],
      ['newPage', false],
    ] as const)('is open in %s: %s', (status, open) => {
      expect(chatOpen(reach[status]())).toBe(open);
    });

    it('is closed while an answer streams in', () => {
      expect(chatOpen(asked())).toBe(false);
    });

    it('is closed after a refusal kept text', () => {
      expect(chatOpen(reduce(streaming(), failed('refused', 'summary')))).toBe(false);
    });
  });

  describe('worker restart', () => {
    it('drops a run the worker lost, then shows the text it saved', () => {
      const panel = [{ type: 'disconnected' } as const, workerState({ summary: { text: 'Saved', status: 'incomplete' } })].reduce(
        reduce,
        streaming(),
      );
      expect(panel).toMatchObject({ status: 'incomplete', summary: { text: 'Saved' } });
    });

    it('offers a fresh start when nothing was saved, with no new request', () => {
      const panel = [{ type: 'disconnected' } as const, workerState()].reduce(reduce, waiting());
      expect(panel).toMatchObject({ status: 'ready', startPending: false });
    });

    it('drops a chat answer the worker lost and keeps the summary', () => {
      const panel = reduce(reduce(complete(), requested({ type: 'chat', text: 'Q' })), { type: 'disconnected' });
      expect(panel).toMatchObject({ status: 'complete', reply: undefined });
    });
  });

  it('changes nothing on Stop until the worker answers', () => {
    const panel = streaming();
    expect(reduce(panel, requested({ type: 'stop' }))).toBe(panel);
  });
});
