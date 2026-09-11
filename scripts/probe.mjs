import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STATUS_SCHEMA_VERSION = 1;
export const PROBE_TIMEOUT_MS = 10_000;
export const PREVIOUS_STATE_MAX_BYTES = 128 * 1024;
export const INCIDENT_MAX_COUNT = 50;
export const INCIDENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const USER_AGENT = 'AlafSanjung-External-Status/1.0';
export const COMPONENT_STATES = new Set(['operational', 'degraded', 'outage', 'unknown']);
export const OVERALL_STATES = new Set(['Operational', 'Degraded', 'Partial Outage', 'Major Outage']);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedCounter(value) {
  return Number.isInteger(value) && value >= 0 && value <= 99 ? value : 0;
}

function boundedResponseMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(60_000, Math.round(value)) : 0;
}

export function validateTargetConfig(value) {
  if (!value || value.schemaVersion !== STATUS_SCHEMA_VERSION || !Array.isArray(value.targets)) {
    throw new Error('Invalid target configuration.');
  }
  if (value.targets.length < 1 || value.targets.length > 10) {
    throw new Error('Invalid target count.');
  }

  const seen = new Set();
  return value.targets.map((target) => {
    const id = boundedString(target?.id, 64);
    const label = boundedString(target?.label, 80);
    if (!id || !SAFE_ID.test(id) || seen.has(id) || !label) {
      throw new Error('Invalid target identity.');
    }
    seen.add(id);

    let url;
    let expectedFinalUrl;
    try {
      url = new URL(target.url);
      expectedFinalUrl = new URL(target.expectedFinalUrl);
    } catch {
      throw new Error('Invalid target URL.');
    }
    if (url.protocol !== 'https:' || expectedFinalUrl.protocol !== 'https:') {
      throw new Error('Only HTTPS targets are supported.');
    }

    const expectedStatuses = Array.isArray(target.expectedStatuses)
      ? [...new Set(target.expectedStatuses.filter((status) => Number.isInteger(status) && status >= 200 && status <= 299))]
      : [];
    const expectedContentTypePrefix = boundedString(target.expectedContentTypePrefix, 80);
    if (expectedStatuses.length === 0 || !expectedContentTypePrefix) {
      throw new Error('Invalid target HTTP contract.');
    }

    return {
      id,
      label,
      url: url.href,
      expectedStatuses,
      expectedFinalUrl: expectedFinalUrl.href,
      expectedContentTypePrefix,
    };
  });
}

function sanitizeComponent(value) {
  const id = boundedString(value?.id, 64);
  const label = boundedString(value?.label, 80);
  if (!id || !SAFE_ID.test(id) || !label || !COMPONENT_STATES.has(value?.status) || !validIso(value?.checkedAt)) {
    return null;
  }
  return {
    id,
    label,
    status: value.status,
    checkedAt: new Date(value.checkedAt).toISOString(),
    responseMs: boundedResponseMs(value.responseMs),
    consecutiveFailures: boundedCounter(value.consecutiveFailures),
    consecutiveSuccesses: boundedCounter(value.consecutiveSuccesses),
  };
}

function sanitizeIncident(value) {
  const id = boundedString(value?.id, 120);
  const componentId = boundedString(value?.componentId, 64);
  const message = boundedString(value?.message, 180);
  if (!id || !componentId || !SAFE_ID.test(componentId) || !message) return null;
  if (!['active', 'resolved'].includes(value?.state) || !COMPONENT_STATES.has(value?.status)) return null;
  if (!validIso(value?.startedAt) || !validIso(value?.updatedAt)) return null;
  if (value.state === 'resolved' && !validIso(value?.resolvedAt)) return null;
  return {
    id,
    componentId,
    state: value.state,
    status: value.status,
    message,
    startedAt: new Date(value.startedAt).toISOString(),
    updatedAt: new Date(value.updatedAt).toISOString(),
    resolvedAt: value.state === 'resolved' ? new Date(value.resolvedAt).toISOString() : null,
  };
}

export function validateStatusSnapshot(value) {
  if (!value || value.schemaVersion !== STATUS_SCHEMA_VERSION || !validIso(value.generatedAt)) return null;
  if (!OVERALL_STATES.has(value.overallStatus) || !Array.isArray(value.components) || !Array.isArray(value.incidents)) return null;
  if (value.components.length < 1 || value.components.length > 10 || value.incidents.length > INCIDENT_MAX_COUNT) return null;

  const components = value.components.map(sanitizeComponent);
  const incidents = value.incidents.map(sanitizeIncident);
  if (components.some((item) => !item) || incidents.some((item) => !item)) return null;
  if (new Set(components.map((item) => item.id)).size !== components.length) return null;
  if (deriveOverallStatus(components) !== value.overallStatus) return null;

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: new Date(value.generatedAt).toISOString(),
    overallStatus: value.overallStatus,
    components,
    incidents,
  };
}

export function parsePreviousStatus(text) {
  try {
    const parsed = JSON.parse(text);
    const snapshot = validateStatusSnapshot(parsed);
    return snapshot ? { kind: 'valid', snapshot } : { kind: 'invalid', snapshot: null };
  } catch {
    return { kind: 'invalid', snapshot: null };
  }
}

async function readResponseTextBounded(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.();
    const error = new Error('Previous status is too large.');
    error.name = 'INVALID_PREVIOUS_STATUS';
    throw error;
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      const error = new Error('Previous status is too large.');
      error.name = 'INVALID_PREVIOUS_STATUS';
      throw error;
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      const error = new Error('Previous status is too large.');
      error.name = 'INVALID_PREVIOUS_STATUS';
      throw error;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function loadPreviousInput(input, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBytes = PREVIOUS_STATE_MAX_BYTES,
} = {}) {
  if (!input) return { kind: 'absent', snapshot: null };

  let text;
  if (/^https:\/\//i.test(input)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(input, {
          method: 'GET',
          redirect: 'follow',
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          return { kind: 'absent', snapshot: null };
        }
        text = await readResponseTextBounded(response, maxBytes);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return error?.name === 'INVALID_PREVIOUS_STATUS'
        ? { kind: 'invalid', snapshot: null }
        : { kind: 'absent', snapshot: null };
    }
  } else {
    try {
      const fileStat = await stat(input);
      if (fileStat.size > maxBytes) return { kind: 'invalid', snapshot: null };
      text = await readFile(input, 'utf8');
    } catch {
      return { kind: 'absent', snapshot: null };
    }
  }
  return parsePreviousStatus(text);
}

export async function probeTarget(target, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const checkedAt = new Date(startedAt).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    const responseMs = boundedResponseMs(now() - startedAt);
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const ok = target.expectedStatuses.includes(response.status)
      && response.url === target.expectedFinalUrl
      && contentType.startsWith(target.expectedContentTypePrefix.toLowerCase());
    await response.body?.cancel?.();
    return { id: target.id, label: target.label, ok, checkedAt, responseMs };
  } catch {
    return {
      id: target.id,
      label: target.label,
      ok: false,
      checkedAt,
      responseMs: boundedResponseMs(now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function transitionComponent(previous, probe, { previousInputKind = 'valid' } = {}) {
  if (previousInputKind === 'invalid') {
    return {
      id: probe.id,
      label: probe.label,
      status: 'unknown',
      checkedAt: probe.checkedAt,
      responseMs: boundedResponseMs(probe.responseMs),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };
  }

  let status;
  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;
  if (probe.ok) {
    consecutiveSuccesses = Math.min(99, (previous?.consecutiveSuccesses || 0) + 1);
    if (!previous || previous.status === 'operational' || previous.status === 'unknown') {
      status = 'operational';
    } else if (previous.status === 'outage') {
      status = 'degraded';
      consecutiveSuccesses = 1;
    } else if (previous.consecutiveSuccesses >= 1) {
      status = 'operational';
    } else {
      status = 'operational';
      consecutiveSuccesses = 1;
    }
  } else {
    consecutiveFailures = Math.min(99, (previous?.consecutiveFailures || 0) + 1);
    if (previous?.status === 'outage' || (previous?.status === 'degraded' && previous.consecutiveFailures >= 1)) {
      status = 'outage';
    } else {
      status = 'degraded';
      consecutiveFailures = 1;
    }
  }

  return {
    id: probe.id,
    label: probe.label,
    status,
    checkedAt: probe.checkedAt,
    responseMs: boundedResponseMs(probe.responseMs),
    consecutiveFailures,
    consecutiveSuccesses,
  };
}

export function deriveOverallStatus(components) {
  if (!Array.isArray(components) || components.length === 0) return 'Degraded';
  const states = components.map((component) => component.status);
  if (states.every((status) => status === 'operational')) return 'Operational';
  if (states.every((status) => status === 'outage')) return 'Major Outage';
  if (states.some((status) => status === 'outage')) return 'Partial Outage';
  return 'Degraded';
}

function incidentMessage(component, recovered = false) {
  if (recovered) return `Automatic availability checks show ${component.label} is operational again.`;
  return `Automatic availability checks detected a problem with ${component.label}.`;
}

export function reconcileIncidents(previousIncidents, components, nowIso) {
  const next = Array.isArray(previousIncidents)
    ? previousIncidents.map((incident) => ({ ...incident }))
    : [];
  const activeByComponent = new Map(
    next.filter((incident) => incident.state === 'active').map((incident) => [incident.componentId, incident]),
  );

  for (const component of components) {
    const active = activeByComponent.get(component.id);
    if (component.status === 'degraded' || component.status === 'outage') {
      if (active) {
        active.status = component.status;
        active.updatedAt = nowIso;
        active.message = incidentMessage(component);
      } else {
        const incident = {
          id: `${component.id}-${nowIso.replace(/[^0-9]/g, '')}`,
          componentId: component.id,
          state: 'active',
          status: component.status,
          message: incidentMessage(component),
          startedAt: nowIso,
          updatedAt: nowIso,
          resolvedAt: null,
        };
        next.push(incident);
        activeByComponent.set(component.id, incident);
      }
    } else if (component.status === 'operational' && active) {
      active.state = 'resolved';
      active.status = 'operational';
      active.message = incidentMessage(component, true);
      active.updatedAt = nowIso;
      active.resolvedAt = nowIso;
      activeByComponent.delete(component.id);
    } else if (component.status === 'unknown' && active) {
      active.status = 'unknown';
      active.updatedAt = nowIso;
    }
  }

  const cutoff = Date.parse(nowIso) - INCIDENT_MAX_AGE_MS;
  return next
    .filter((incident) => Number.isFinite(Date.parse(incident.updatedAt)) && Date.parse(incident.updatedAt) >= cutoff)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, INCIDENT_MAX_COUNT);
}

export function buildStatusSnapshot({ targets, probes, previous, previousInputKind = 'absent', nowIso }) {
  const previousById = new Map((previous?.components || []).map((component) => [component.id, component]));
  const probesById = new Map(probes.map((probe) => [probe.id, probe]));
  const components = targets.map((target) => transitionComponent(
    previousById.get(target.id),
    probesById.get(target.id) || {
      id: target.id,
      label: target.label,
      ok: false,
      checkedAt: nowIso,
      responseMs: 0,
    },
    { previousInputKind },
  ));
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: nowIso,
    overallStatus: deriveOverallStatus(components),
    components,
    incidents: reconcileIncidents(previous?.incidents || [], components, nowIso),
  };
}

function parseArgs(argv) {
  const options = {
    config: path.join(PACKAGE_ROOT, 'config', 'targets.json'),
    previous: '',
    output: path.resolve(process.cwd(), 'dist', 'status.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--config', '--previous', '--output'].includes(name) || !argv[index + 1]) {
      throw new Error('Invalid arguments.');
    }
    options[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

export async function runProbeBuild(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const now = dependencies.now || (() => Date.now());
  const configText = await readFile(options.config, 'utf8');
  const targets = validateTargetConfig(JSON.parse(configText));
  const previousResult = await loadPreviousInput(options.previous, { fetchImpl });
  const probes = await Promise.all(targets.map((target) => probeTarget(target, { fetchImpl, now })));
  const nowIso = new Date(now()).toISOString();
  const snapshot = buildStatusSnapshot({
    targets,
    probes,
    previous: previousResult.snapshot,
    previousInputKind: previousResult.kind,
    nowIso,
  });
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

async function main() {
  try {
    await runProbeBuild(parseArgs(process.argv.slice(2)));
  } catch {
    process.stderr.write('External status build failed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
