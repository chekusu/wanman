/**
 * HTTP server for the Agent Matrix Supervisor.
 *
 * Endpoints:
 *   GET  /health        — Health check, returns agent list and states
 *   POST /rpc           — JSON-RPC 2.0 endpoint for wanman CLI
 *   POST /events        — External event ingestion (webhooks, cron)
 */

import * as http from 'http';
import type { JsonRpcRequest, JsonRpcResponse, ExternalEvent } from '@wanman/core';
import { createLogger } from './logger.js';
import { buildDashboardPage } from './dashboard-page.js';

const log = createLogger('http-server');

export type RpcHandler = (req: JsonRpcRequest) => JsonRpcResponse | Promise<JsonRpcResponse>;
export type EventHandler = (event: ExternalEvent) => void;
export type HealthHandler = () => unknown;
export type DashboardDataHandler = () => unknown;
export type DashboardEventsHandler = (send: (event: unknown) => void) => (() => void) | void;

export interface HttpServerOptions {
  port: number;
  onRpc: RpcHandler;
  onEvent: EventHandler;
  onHealth: HealthHandler;
  onDashboardData?: DashboardDataHandler;
  onDashboardEvents?: DashboardEventsHandler;
}

/** Maximum request body size (1 MB). */
const MAX_BODY_SIZE = 1 * 1024 * 1024;

/** Parse JSON body from request with size limit. */
function parseBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Send JSON response */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, status: number, data: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(data);
}

export function createHttpServer(opts: HttpServerOptions): http.Server {
  const { port, onRpc, onEvent, onHealth, onDashboardData, onDashboardEvents } = opts;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, onHealth());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/dashboard') {
        sendHtml(res, 200, buildDashboardPage());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/dashboard/data') {
        sendJson(res, 200, onDashboardData ? onDashboardData() : { error: 'Dashboard data unavailable' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/dashboard/events') {
        if (!onDashboardEvents) {
          sendJson(res, 503, { error: 'Dashboard event stream unavailable' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const unsubscribe = onDashboardEvents((event) => {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        req.on('close', () => {
          unsubscribe?.();
          if (!res.writableEnded) {
            res.end();
          }
        });
        return;
      }

      // JSON-RPC endpoint
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const rpcReq = await parseBody<JsonRpcRequest>(req);
        if (!rpcReq.jsonrpc || rpcReq.jsonrpc !== '2.0' || !rpcReq.method) {
          sendJson(res, 400, { error: 'Invalid JSON-RPC 2.0 request' });
          return;
        }
        const rpcRes = await onRpc(rpcReq);
        sendJson(res, 200, rpcRes);
        return;
      }

      // External events
      if (req.method === 'POST' && url.pathname === '/events') {
        const event = await parseBody<ExternalEvent>(req);
        onEvent(event);
        sendJson(res, 200, { status: 'accepted' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      log.error('request error', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`listening on port ${port}`);
  });

  return server;
}
