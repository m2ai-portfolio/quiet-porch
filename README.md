# Quiet Porch

An AI home deterrent for the Amazon Developer Hackathon (Build, Ship, Shape, 2026), Ring and
Alexa+ tracks, with Amazon Bedrock for the AWS Builder mini-challenge.

A Ring motion event becomes a judged, logged decision. A person who is still there at night
gets a calm, escalating response (interior lights, then exterior light, a short bark clip, a
sprinkler), and an armadillo in the yard gets the sprinkler. Benign events (deliveries, cars,
pets) get no action at all. Every decision is logged with its frame and timestamps, and an
owner can stand everything down from a signed Stop link or by asking Alexa.

## How it works

```
Ring webhook (signed)
   |
   v
server.ts  -- verify HMAC, dedupe, log
   |
   v
pipeline.ts
   frames.ts      event frame at the event timestamp, capture time proven by Ring headers
   perception.ts  Bedrock describes the frame (subjects, activity, night IR)
   critique.ts    Bedrock weighs it against household context (mode, routines, visitors)
   decide.ts      deterministic profile: log / intruder / wildlife / reject (stale, no evidence)
   |
   v
coordinator.ts  -- one active incident, write-ahead intents, cooldowns, cleanup, reconcile
   ladder.ts      L1 interior lights + notify, L2 exterior light, L3 bark clip, L4 sprinkler
   allowlist.ts   every Home Assistant call checked; locks, covers and alarms are never allowed
   actuators.ts   Home Assistant REST, Pi speaker, Telegram (or a dry-run simulator)
   |
   v
mcp.ts  -- status-mcp, MCP 2025-11-25 over Streamable HTTP, for Alexa+:
           get_incident_status, list_recent_incidents, stand_down, set_mode
```

The models never decide timing or act directly: capture time comes from Ring, the profile and
ladder are deterministic code, and escalation needs fresh evidence (stale frames are refused).

## Status

Running live in **dry run**: real Ring events and real Bedrock calls, but every actuator call is
simulated and logged. See [`docs/recon.md`](docs/recon.md) for measured results and
[`docs/plan-v7.md`](docs/plan-v7.md) for the plan and its gates.

## Run

Requires Node 22.18 or later (TypeScript runs natively), a Ring developer integration, a Bedrock
API key, and Home Assistant for actuators.

```bash
npm install
cp config/quiet-porch.example.json config/quiet-porch.json   # then fill in your devices and URL
cp config/allowlist.example.json config/allowlist.json       # if you need a fresh allowlist
npm test
npm start
```

Environment: `AWS_BEARER_TOKEN_BEDROCK`, plus optional `QUIET_PORCH_PORT`,
`QUIET_PORCH_STATE_DIR`, `QUIET_PORCH_CONFIG`, `QUIET_PORCH_MCP_HOST`, `QUIET_PORCH_MCP_PORT`.
Tokens and frames are kept in the state directory (default `~/.local/state/quiet-porch`), never
in the repo.

The simulated Alexa+ client is `src/alexa-sim.html`, served by status-mcp at `/alexa`.

## License

MIT
