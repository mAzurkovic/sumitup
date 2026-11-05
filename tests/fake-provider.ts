import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** The port the test build's provider address names. */
export const FAKE_PORT = 4319;
export const FAKE_ORIGIN = `http://127.0.0.1:${FAKE_PORT}`;
/** The key the fake rejects when the extension checks it. */
export const REJECTED_KEY = 'sk-ant-rejected-0000';

export interface StreamReply {
  text?: string[];
  /** Anthropic's stop reason, sent when the stream finishes. */
  stop?: string;
  /**
   * How the stream ends: `finish` sends the stop reason, `hold` keeps it open until the client leaves,
   * `end` closes it with no finish event, `drop` cuts the connection, and `errorEvent` sends an error inside the stream.
   */
  then?: 'finish' | 'hold' | 'end' | 'drop' | 'errorEvent';
  /** Wait before each piece of text. */
  gapMs?: number;
}

export interface StatusReply {
  status: number;
  body?: string;
}

export type Reply = StreamReply | StatusReply;

export interface ProviderRequest {
  path: string;
  key?: string;
  body?: { model: string; system: string; messages: { role: string; content: string }[] };
}

const DEFAULT_REPLY: StreamReply = { text: ['- Default summary.'] };

const event = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
const textEvent = (text: string) => event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function stream(response: ServerResponse, reply: StreamReply): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(event({ type: 'message_start', message: { role: 'assistant', content: [] } }));
  for (const text of reply.text ?? []) {
    if (reply.gapMs) await wait(reply.gapMs);
    if (response.destroyed) return;
    response.write(textEvent(text));
  }
  switch (reply.then ?? 'finish') {
    case 'finish':
      response.write(event({ type: 'message_delta', delta: { stop_reason: reply.stop ?? 'end_turn' } }));
      response.end(event({ type: 'message_stop' }));
      return;
    case 'hold':
      return;
    case 'end':
      response.end();
      return;
    case 'drop':
      // A cut right after a write would throw away text the client has not read yet.
      await wait(300);
      response.socket?.destroy();
      return;
    case 'errorEvent':
      response.end(event({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  }
}

/**
 * Stands in for the provider and for the web pages under test. Each summary or chat call takes the next scripted reply.
 */
export class FakeProvider {
  readonly requests: ProviderRequest[] = [];
  private readonly replies: Reply[] = [];
  private readonly pages = new Map<string, string>();
  private server?: Server;

  /** Queues the replies for the next summary and chat calls, in order. */
  script(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  page(path: string, html: string): string {
    this.pages.set(path, html);
    return FAKE_ORIGIN + path;
  }

  /** Summary and chat calls only, not key checks. */
  get calls(): ProviderRequest[] {
    return this.requests.filter(({ path }) => path === '/v1/messages');
  }

  reset(): void {
    this.requests.length = 0;
    this.replies.length = 0;
    this.pages.clear();
  }

  start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        console.error(error);
        response.destroy();
      });
    });
    return new Promise((resolve) => this.server!.listen(FAKE_PORT, '127.0.0.1', resolve));
  }

  stop(): Promise<void> {
    this.server?.closeAllConnections();
    return new Promise((resolve, reject) => this.server?.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url!, FAKE_ORIGIN).pathname;
    const page = this.pages.get(path);
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (!path.startsWith('/v1/')) {
      response.writeHead(404).end();
      return;
    }

    const key = request.headers['x-api-key'] as string | undefined;
    const text = await readBody(request);
    this.requests.push({ path, key, ...(text && { body: JSON.parse(text) }) });

    if (path === '/v1/models') {
      const accepted = key !== REJECTED_KEY;
      response.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
      response.end(accepted ? '{"data":[]}' : '{"type":"error","error":{"type":"authentication_error"}}');
      return;
    }
    const reply = this.replies.shift() ?? DEFAULT_REPLY;
    if ('status' in reply) {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.body ?? '{"type":"error","error":{"type":"api_error"}}');
      return;
    }
    await stream(response, reply);
  }
}
