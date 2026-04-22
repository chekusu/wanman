/**
 * wanman artifact put|list|get
 *
 * Structured artifact storage for Agent Matrix deliverables.
 */

import { readFileSync } from 'node:fs';
import { RPC_METHODS } from '@wanman/core';
import { rpcCall } from '../transport.js';

/** Standard kind values — warn (not block) on non-standard kinds */
const STANDARD_KINDS = new Set([
  'competitor', 'market_data', 'customer_profile', 'location_data',
  'budget_item', 'revenue_forecast', 'financial_summary',
  'brand_asset', 'content_plan', 'tech_spec',
]);

const USAGE = `Usage:
  wanman artifact put --kind <kind> --path <path> --source <source> --confidence <0-1> [--task <id>] [--file <path>] [--content <text>] [--allow-nonstandard] '<metadata json>'
  wanman artifact list [--agent <name>] [--kind <kind>] [--unverified]
  wanman artifact get <id>

Standard --kind values:
  competitor, market_data, customer_profile, location_data,
  budget_item, revenue_forecast, financial_summary,
  brand_asset, content_plan, tech_spec

--path format: {domain}/{category}/{item}
  e.g. costs/opex/rent, market/competitors/cafe-a, brand/naming/candidate-1

--file: read file content and store it in the artifact (up to 10MB text files)
--content: store inline text content in the artifact
--allow-nonstandard: permit a kind outside the standard list (marked in metadata)

Examples:
  wanman artifact put --kind brand_asset --path "brand/identity/handbook" --source "marketing" --confidence 0.9 --file /workspace/agents/marketing/output/brand-design.md '{"name":"Brand Handbook"}'
  wanman artifact put --kind budget_item --path "costs/opex/rent" --source "estimate" --confidence 0.4 '{"item":"rent","amount":350000,"currency":"JPY"}'
  wanman artifact list --agent finance
  wanman artifact list --unverified
  wanman artifact get 42`;

export async function artifactCommand(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case 'put': {
      const kind = extractFlag(args, '--kind');
      const source = extractFlag(args, '--source');
      const confidenceStr = extractFlag(args, '--confidence');
      const taskId = extractFlag(args, '--task');
      const path = extractFlag(args, '--path');
      const filePath = extractFlag(args, '--file');
      const inlineContent = extractFlag(args, '--content');

      // --file reads the file content; --content takes inline text; --file wins if both given
      let content: string | undefined;
      if (filePath) {
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch (err) {
          console.error(`Error: cannot read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      } else if (inlineContent) {
        content = inlineContent;
      }

      if (!kind || !source || !confidenceStr || !path) {
        console.error('Error: --kind, --path, --source, and --confidence are required');
        console.error(USAGE);
        process.exit(1);
      }

      // Validate kind against standard list. Default is to block; agents opt in to
      // non-standard kinds explicitly with --allow-nonstandard, which also flags the
      // artifact in metadata so downstream tooling can surface the divergence.
      const allowNonStandard = args.includes('--allow-nonstandard');
      let nonStandardKind = false;
      if (!STANDARD_KINDS.has(kind)) {
        if (!allowNonStandard) {
          console.error(`Error: non-standard kind "${kind}". Standard kinds: ${[...STANDARD_KINDS].join(', ')}`);
          console.error(`Pass --allow-nonstandard if you really need this (the artifact will be flagged in metadata).`);
          process.exit(1);
        }
        nonStandardKind = true;
        console.error(`Warning: non-standard kind "${kind}" allowed via --allow-nonstandard`);
      }

      // Validate path format: should be domain/category/item
      if (!path.includes('/')) {
        console.error(`Warning: --path should use format "{domain}/{category}/{item}", got "${path}"`);
      }

      const confidence = parseFloat(confidenceStr);
      if (isNaN(confidence) || confidence < 0 || confidence > 1) {
        console.error('Error: --confidence must be a number between 0 and 1');
        process.exit(1);
      }

      // Last positional arg is the metadata JSON
      const metadataJson = extractPositional(args.slice(1));
      if (!metadataJson) {
        console.error('Error: metadata JSON is required as the last argument');
        console.error(USAGE);
        process.exit(1);
      }

      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(metadataJson);
      } catch {
        console.error('Error: invalid metadata JSON');
        process.exit(1);
      }

      if (nonStandardKind) {
        metadata['non_standard_kind'] = true;
      }

      const agent = process.env['WANMAN_AGENT_NAME'] || 'cli';
      const resp = await rpcCall(RPC_METHODS.ARTIFACT_PUT, {
        kind,
        agent,
        source,
        confidence,
        taskId,
        path,
        content,
        metadata,
      });

      if (resp.error) {
        console.error(`Error: ${resp.error.message}`);
        process.exit(1);
      }

      console.log(`Artifact stored: kind=${kind} source=${source} confidence=${confidence}`);
      break;
    }

    case 'list': {
      const agent = extractFlag(args, '--agent');
      const kind = extractFlag(args, '--kind');
      const unverified = args.includes('--unverified');

      const resp = await rpcCall(RPC_METHODS.ARTIFACT_LIST, {
        agent,
        kind,
        ...(unverified ? { verified: false } : {}),
      });

      if (resp.error) {
        console.error(`Error: ${resp.error.message}`);
        process.exit(1);
      }

      const rows = resp.result as Array<{ id: number; agent: string; kind: string; path: string; content_length: number | null; metadata: Record<string, unknown>; created_at: string }>;
      if (!Array.isArray(rows) || rows.length === 0) {
        console.log('No artifacts found.');
        return;
      }

      for (const r of rows) {
        const source = (r.metadata?.source as string) || '?';
        const confidence = r.metadata?.confidence ?? '?';
        const verified = r.metadata?.verified ? '\u2713' : '\u2717';
        const contentInfo = r.content_length ? ` [${formatBytes(r.content_length)}]` : '';
        const pathInfo = r.path ? ` path=${r.path}` : '';
        console.log(`[${verified}] #${r.id} ${r.kind} (${r.agent})${pathInfo} source=${source} confidence=${confidence}${contentInfo}`);
      }
      console.log(`\n${rows.length} artifact(s)`);
      break;
    }

    case 'get': {
      const id = args[1];
      if (!id) {
        console.error('Error: artifact id is required');
        console.error(USAGE);
        process.exit(1);
      }
      const resp = await rpcCall(RPC_METHODS.ARTIFACT_GET, { id: parseInt(id, 10) });
      if (resp.error) {
        console.error(`Error: ${resp.error.message}`);
        process.exit(1);
      }
      const rows = resp.result as Array<{ id: number; agent: string; kind: string; path: string; content: string | null; metadata: Record<string, unknown>; created_at: string }>;
      if (!Array.isArray(rows) || rows.length === 0) {
        console.error(`Artifact #${id} not found`);
        process.exit(1);
      }
      const r = rows[0]!;
      console.log(`# Artifact #${r.id}`);
      console.log(`kind: ${r.kind}`);
      console.log(`agent: ${r.agent}`);
      console.log(`path: ${r.path || '(none)'}`);
      console.log(`created_at: ${r.created_at}`);
      console.log(`metadata: ${JSON.stringify(r.metadata, null, 2)}`);
      if (r.content) {
        console.log(`\n--- content (${formatBytes(r.content.length)}) ---\n`);
        console.log(r.content);
      } else {
        console.log('\n(no content stored)');
      }
      break;
    }

    default:
      console.error(USAGE);
      process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Extract positional args (everything before flags). */
function extractPositional(args: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) {
      if (args[i] !== '--allow-nonstandard') i++; // skip flag value
      continue;
    }
    parts.push(args[i]!);
  }
  return parts.join(' ');
}

/** Extract a flag value: --flag value */
function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
