import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react';
import type { Browser } from 'wxt/browser';
import type { PanelMessage, PanelRequest } from '@/lib/messages';
import { MODELS } from '@/lib/models';
import { ChatInput } from './ChatInput';
import { ChatMessages } from './ChatMessages';
import { Header } from './Header';
import { KeySetup } from './KeySetup';
import { LevelSelect } from './LevelSelect';
import { MODEL_MENU_ID, ModelMenu } from './ModelMenu';
import { ModelSwitchAction } from './ModelSwitchAction';
import { ScopeLink } from './ScopeLink';
import { ScrollColumn } from './ScrollColumn';
import { StatusCard } from './StatusCard';
import { SummaryCard } from './SummaryCard';
import { chatOpen, initialPanel, reduce, type Panel, type Settings } from './state';

/** Keeps a port to the worker, and opens a new one when a restarted worker drops it. */
function useWorker(tabId: number) {
  const [panel, dispatch] = useReducer(reduce, initialPanel);
  const port = useRef<Browser.runtime.Port>(null);

  useEffect(() => {
    const connect = () => {
      const opened = browser.runtime.connect({ name: `panel:${tabId}` });
      opened.onMessage.addListener((message) => dispatch(message as PanelMessage));
      opened.onDisconnect.addListener(() => {
        dispatch({ type: 'disconnected' });
        connect();
      });
      port.current = opened;
    };
    connect();
    return () => port.current?.disconnect();
  }, [tabId]);

  const send = useCallback((request: PanelRequest) => {
    port.current?.postMessage(request);
    dispatch({ type: 'requested', request });
  }, []);
  const cancel = useCallback(() => dispatch({ type: 'cancel' }), []);

  useEffect(() => {
    if (panel.startPending) send({ type: 'summarize' });
  }, [panel.startPending, send]);

  useEffect(() => {
    if (panel.openMenu) document.getElementById(MODEL_MENU_ID)!.showPopover();
  }, [panel.openMenu]);

  return { panel, send, cancel };
}

interface BodyProps {
  panel: Panel;
  settings: Settings;
  send: (request: PanelRequest) => void;
  cancel: () => void;
}

function Body({ panel, settings, send, cancel }: BodyProps): ReactNode {
  const { status, summary, error, chat, reply } = panel;
  const summarize = () => send({ type: 'summarize' });
  const stop = () => send({ type: 'stop' });
  // A failed chat answer is asked again. Anything else makes a new summary.
  const retry = () => send(error?.question ? { type: 'chat', text: error.question } : { type: 'retry' });

  if (status === 'waiting') return <StatusCard view={{ kind: 'waiting', onStop: stop }} />;
  if (status === 'ready' || status === 'newPage') {
    return <StatusCard view={{ kind: 'start', newPage: status === 'newPage', onStart: summarize }} />;
  }
  if (status === 'confirmLong') {
    const onContinue = () => send({ type: 'summarize', confirmed: true });
    return <StatusCard view={{ kind: 'confirmLong', tokens: panel.confirmTokens!, onContinue, onCancel: cancel }} />;
  }
  // Every view left with no summary is a failure, and the reducer always sets its error.
  if (!summary) return <StatusCard view={{ kind: 'failure', failure: error!.kind, banner: false, onRetry: retry }} />;

  const switchedTo = summary.modelId !== settings.modelId && MODELS.find(({ id }) => id === settings.modelId);
  return (
    <>
      {switchedTo && status !== 'streaming' && <ModelSwitchAction modelName={switchedTo.name} onClick={summarize} />}
      {error && <StatusCard view={{ kind: 'failure', failure: error.kind, banner: true, onRetry: retry }} />}
      <ScrollColumn newest={chat.length + (reply ? 1 : 0)}>
        <SummaryCard
          text={summary.text}
          streaming={status === 'streaming'}
          incomplete={status === 'incomplete'}
          videoExcluded={panel.videoExcluded}
          onStop={stop}
          onRetry={retry}
        />
        <hr className="divider" />
        <ChatMessages chat={chat} reply={reply} />
      </ScrollColumn>
    </>
  );
}

export function App({ tabId }: { tabId: number }) {
  const { panel, send, cancel } = useWorker(tabId);
  const { settings } = panel;
  if (!settings) return null;

  const close = () => browser.sidePanel.close({ tabId });
  const chat = (
    <ChatInput open={chatOpen(panel)} scope={settings.scope} onSend={(text) => send({ type: 'chat', text })} />
  );

  if (panel.status === 'needsKey') {
    return (
      <main className="panel">
        <Header title="Add an API key to start" onClose={close} />
        <div className="body">
          <KeySetup error={panel.error?.kind} onSave={(key) => send({ type: 'saveKey', key })} />
        </div>
        {chat}
      </main>
    );
  }

  return (
    <main className="panel">
      <Header title={settings.scope === 'selection' ? 'Selected text summary' : 'Page summary'} onClose={close}>
        <div className="controls">
          <LevelSelect level={settings.level} onChange={(level) => send({ type: 'setLevel', level })} />
          <ModelMenu
            modelId={settings.modelId}
            keyEnding={settings.keyEnding!}
            onModelChange={(modelId) => send({ type: 'setModel', modelId })}
            onDeleteKey={() => send({ type: 'deleteKey' })}
          />
        </div>
      </Header>
      {settings.scope === 'selection' && <ScopeLink onClick={() => send({ type: 'summarize', wholePage: true })} />}
      <div className="body">
        <Body panel={panel} settings={settings} send={send} cancel={cancel} />
      </div>
      {chat}
    </main>
  );
}
