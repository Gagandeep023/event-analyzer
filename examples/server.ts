/**
 * Runnable demo server.
 *
 * Seeds deterministic synthetic events, mounts the router, and prints the curl
 * commands for every endpoint. Doubles as the copy-paste integration example in
 * the README, so the documentation cannot drift from something that runs.
 *
 *   npm run demo
 */

import express from 'express';
import { createEventAnalyzerRouter, MemoryStore } from '../src/backend';
import { generate, describeSeed } from './seed';

const PORT = Number(process.env.PORT ?? 4800);
const BASE = `http://localhost:${PORT}/api/events`;

async function main(): Promise<void> {
  const store = new MemoryStore({ maxEvents: 500_000 });

  const { events, malformed } = generate({ users: 400, days: 90 });
  await store.append(events);
  console.log(`seeded: ${describeSeed({ events, malformed })}`);

  const app = express();

  app.use('/api/events', createEventAnalyzerRouter(express, {
    store,
    // No apiKeys and no queryAuth: this is a local demo. A real deployment must
    // set queryAuth, since /query and /stream expose every event in the store.
    logger: console,
  }));

  app.get('/', (_req, res) => {
    res.type('text/plain').send(HELP);
  });

  app.listen(PORT, () => {
    console.log(`\nevent-analyzer demo on ${BASE}\n`);
    console.log(HELP);
  });

  // Prove the index-addressed 400 path works against a live server.
  setTimeout(() => {
    void fetch(`${BASE}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: malformed }),
    })
      .then((r) => r.json())
      .then((body) => console.log('\nmalformed batch response:', JSON.stringify(body, null, 2)));
  }, 250);
}

const NOW = Date.now();
const FROM = NOW - 90 * 86_400_000;

const HELP = `
  health       curl ${BASE}/health
  meta         curl ${BASE}/meta
  export       curl "${BASE}/export?from=${FROM}&to=${NOW}" | head -3
  live feed    curl -N ${BASE}/stream

  collect
    curl -X POST ${BASE}/collect -H 'Content-Type: application/json' \\
      -d '{"events":[{"event_type":"Demo","user_id":"demo_user"}]}'

  segmentation
    curl -X POST ${BASE}/query/segmentation -H 'Content-Type: application/json' \\
      -d '{"events":[{"event_type":"Signed Up"}],"countBy":"uniques","granularity":"day","range":{"from":${FROM},"to":${NOW}}}'

  funnel
    curl -X POST ${BASE}/query/funnel -H 'Content-Type: application/json' \\
      -d '{"steps":[{"event_type":"Signed Up"},{"event_type":"Project Created"},{"event_type":"Teammate Invited"},{"event_type":"Plan Upgraded"}],"order":"ordered","conversionWindowMs":2592000000,"countBy":"uniques","range":{"from":${FROM},"to":${NOW}}}'

  retention (try n-day, unbounded and bracket; they disagree)
    curl -X POST ${BASE}/query/retention -H 'Content-Type: application/json' \\
      -d '{"startAction":{"event_type":"Signed Up"},"returnAction":{"event_type":"*"},"measure":"unbounded","interval":"day","periods":30,"range":{"from":${FROM},"to":${NOW}}}'

  sessions
    curl -X POST ${BASE}/query/sessions -H 'Content-Type: application/json' \\
      -d '{"granularity":"day","range":{"from":${FROM},"to":${NOW}}}'

  cohort
    curl -X POST ${BASE}/query/cohort -H 'Content-Type: application/json' \\
      -d '{"did":[{"step":{"event_type":"Signed Up"}}],"didNot":[{"event_type":"Plan Upgraded"}],"range":{"from":${FROM},"to":${NOW}}}'
`;

void main();
