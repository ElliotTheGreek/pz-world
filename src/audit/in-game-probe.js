const BEGIN = /^PZWORLD_VALIDATION begin\s+(.+)$/;
const COMPLETE = /^PZWORLD_VALIDATION complete\s+(.+)$/;
const ERROR = /^PZWORLD_VALIDATION (?:error|arm-error)\s+(.+)$/;

function fields(text) {
  return Object.fromEntries([...text.matchAll(/([A-Za-z]+)=([^\s]+)/g)].map((match) => {
    const value = /^-?\d+(?:\.\d+)?$/.test(match[2]) ? Number(match[2]) : match[2];
    return [match[1], value];
  }));
}

/** Parse only the bounded PZWORLD_VALIDATION records from a Project Zomboid console. */
export function parseInGameProbe(text) {
  const records = [];
  const errors = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^.*?(PZWORLD_VALIDATION )/, '$1');
    let match = BEGIN.exec(line);
    if (match) {
      records.push({ type: 'begin', ...fields(match[1]) });
      continue;
    }
    match = COMPLETE.exec(line);
    if (match) {
      records.push({ type: 'complete', ...fields(match[1]) });
      continue;
    }
    match = ERROR.exec(line);
    if (match) errors.push(match[1]);
  }
  return { records, errors };
}

export const REQUIRED_RUNTIME_CHECKS = Object.freeze([
  'urbanJunction',
  'diagonalCurb',
  'highwayRamp',
  'ruralRoad',
  'bridgeApproach',
  'parkingAndEntrance',
  'nativeStability',
]);

/** Validate the human-observed half of runtime acceptance without inventing evidence. */
export function validateRuntimeObservations(observations) {
  const problems = [];
  if (!observations || typeof observations !== 'object') {
    return { valid: false, problems: ['runtime observations must be an object'] };
  }
  for (const field of ['gameVersion', 'runAt', 'route', 'observer']) {
    if (!String(observations[field] ?? '').trim()) problems.push(`observations require ${field}`);
  }
  if (observations.runAt && !Number.isFinite(Date.parse(observations.runAt))) {
    problems.push('runAt must be an ISO-8601 timestamp');
  }
  if (observations.gameVersion && !/^42(?:\.|$)/.test(String(observations.gameVersion))) {
    problems.push(`gameVersion must identify Build 42, got ${observations.gameVersion}`);
  }
  for (const key of REQUIRED_RUNTIME_CHECKS) {
    const check = observations.checks?.[key];
    if (!check || check.passed !== true || !String(check.notes ?? '').trim()) {
      problems.push(`${key} requires passed=true and non-empty notes`);
    }
  }
  return { valid: problems.length === 0, problems };
}

/** Apply the documented five-minute streaming acceptance thresholds. */
export function validateInGameProbe(text, options = {}) {
  const minimumElapsedMs = options.minimumElapsedMs ?? 300000;
  const minimumChunkTransitions = options.minimumChunkTransitions ?? 20;
  const minimumCellTransitions = options.minimumCellTransitions ?? 2;
  const parsed = parseInGameProbe(text);
  const problems = parsed.errors.map((error) => `probe error: ${error}`);
  const begin = parsed.records.find((record) => record.type === 'begin');
  const complete = [...parsed.records].reverse().find((record) => record.type === 'complete');
  if (!begin) problems.push('missing PZWORLD_VALIDATION begin record');
  if (!complete) problems.push('missing PZWORLD_VALIDATION complete record');
  if (complete) {
    if (complete.reason !== 'five-minutes') problems.push(`probe ended with reason=${complete.reason}`);
    if (!(complete.elapsedMs >= minimumElapsedMs)) problems.push(`elapsedMs ${complete.elapsedMs ?? 'missing'} is below ${minimumElapsedMs}`);
    if (complete.missingSquares !== 0) problems.push(`missingSquares must be 0, got ${complete.missingSquares ?? 'missing'}`);
    if (!(complete.chunkTransitions >= minimumChunkTransitions)) problems.push(`chunkTransitions ${complete.chunkTransitions ?? 'missing'} is below ${minimumChunkTransitions}`);
    if (!(complete.cellTransitions >= minimumCellTransitions)) problems.push(`cellTransitions ${complete.cellTransitions ?? 'missing'} is below ${minimumCellTransitions}`);
  }
  return { valid: problems.length === 0, problems, begin, complete, errors: parsed.errors };
}
