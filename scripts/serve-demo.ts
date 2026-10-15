import { createDemoServer } from '../src/demo.ts';
import { arg } from './lib.ts';
import { resolve } from 'node:path';
const host = arg('host') ?? '0.0.0.0';
const port = Number(arg('port') ?? 3472);
const demo = await createDemoServer({ stateDir: resolve(arg('state-dir') ?? 'state/rehearsal') });
demo.server.listen(port, host, () =>
  console.log(
    `Synthetic rehearsal listening on ${host}:${port}; no hardware or external-service calls.`,
  ),
);
process.on('SIGTERM', () =>
  demo.server.close(() => {
    demo.close();
    process.exit(0);
  }),
);
process.on('SIGINT', () =>
  demo.server.close(() => {
    demo.close();
    process.exit(0);
  }),
);
