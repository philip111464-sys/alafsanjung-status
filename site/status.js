(function initializeExternalStatus(root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STALE_AFTER_MS = 30 * 60 * 1000;
  const MAX_STATUS_BYTES = 128 * 1024;
  const COMPONENT_STATES = new Set(['operational', 'degraded', 'outage', 'unknown']);
  const OVERALL_STATES = new Set(['Operational', 'Degraded', 'Partial Outage', 'Major Outage']);
  const INCIDENT_STATES = new Set(['active', 'resolved']);
  const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

  function validIso(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }

  function validText(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  function expectedOverallStatus(components) {
    const states = components.map((component) => component.status);
    if (states.every((status) => status === 'operational')) return 'Operational';
    if (states.every((status) => status === 'outage')) return 'Major Outage';
    if (states.some((status) => status === 'outage')) return 'Partial Outage';
    return 'Degraded';
  }

  function validateStatusPayload(value) {
    if (!value || value.schemaVersion !== SCHEMA_VERSION || !validIso(value.generatedAt)) return null;
    if (!OVERALL_STATES.has(value.overallStatus) || !Array.isArray(value.components) || !Array.isArray(value.incidents)) return null;
    if (value.components.length < 1 || value.components.length > 10 || value.incidents.length > 50) return null;

    const components = value.components.map((component) => {
      if (!validText(component?.id, 64) || !SAFE_ID.test(component.id)) return null;
      if (!validText(component?.label, 80) || !COMPONENT_STATES.has(component?.status) || !validIso(component?.checkedAt)) return null;
      if (!Number.isFinite(component?.responseMs) || component.responseMs < 0 || component.responseMs > 60_000) return null;
      return {
        id: component.id,
        label: component.label,
        status: component.status,
        checkedAt: new Date(component.checkedAt).toISOString(),
        responseMs: Math.round(component.responseMs),
      };
    });
    if (components.some((component) => !component)) return null;
    if (new Set(components.map((component) => component.id)).size !== components.length) return null;
    if (expectedOverallStatus(components) !== value.overallStatus) return null;

    const incidents = value.incidents.map((incident) => {
      if (!validText(incident?.id, 120) || !validText(incident?.componentId, 64)) return null;
      if (!validText(incident?.message, 180) || !INCIDENT_STATES.has(incident?.state) || !COMPONENT_STATES.has(incident?.status)) return null;
      if (!validIso(incident?.startedAt) || !validIso(incident?.updatedAt)) return null;
      if (incident.state === 'resolved' && !validIso(incident?.resolvedAt)) return null;
      return {
        id: incident.id,
        componentId: incident.componentId,
        state: incident.state,
        status: incident.status,
        message: incident.message,
        startedAt: new Date(incident.startedAt).toISOString(),
        updatedAt: new Date(incident.updatedAt).toISOString(),
        resolvedAt: incident.state === 'resolved' ? new Date(incident.resolvedAt).toISOString() : null,
      };
    });
    if (incidents.some((incident) => !incident)) return null;

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date(value.generatedAt).toISOString(),
      overallStatus: value.overallStatus,
      components,
      incidents,
    };
  }

  function malaysiaTime(iso) {
    return new Intl.DateTimeFormat('en-MY', {
      timeZone: 'Asia/Kuala_Lumpur',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  }

  function statusLabel(status) {
    return {
      operational: 'Operational',
      degraded: 'Degraded',
      outage: 'Outage',
      unknown: 'Unknown',
    }[status] || 'Unknown';
  }

  function statusClass(status) {
    return COMPONENT_STATES.has(status) ? `status-${status}` : 'status-unknown';
  }

  function replaceChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function createTextElement(documentRef, tagName, text, className) {
    const element = documentRef.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function setGeneratedAt(documentRef, iso) {
    const time = documentRef.getElementById('generated-at');
    time.textContent = malaysiaTime(iso);
    time.setAttribute('datetime', iso);
  }

  function renderComponents(documentRef, components) {
    const container = documentRef.getElementById('components');
    replaceChildren(container);
    for (const component of components) {
      const card = documentRef.createElement('article');
      card.className = 'component-card';
      const top = documentRef.createElement('div');
      top.className = 'component-topline';
      top.appendChild(createTextElement(documentRef, 'h3', component.label));
      top.appendChild(createTextElement(
        documentRef,
        'span',
        statusLabel(component.status),
        `status-badge ${statusClass(component.status)}`,
      ));
      card.appendChild(top);
      card.appendChild(createTextElement(
        documentRef,
        'p',
        `Checked ${malaysiaTime(component.checkedAt)} · ${component.responseMs} ms`,
        'component-meta',
      ));
      container.appendChild(card);
    }
  }

  function renderIncidents(documentRef, incidents) {
    const container = documentRef.getElementById('incidents');
    replaceChildren(container);
    if (incidents.length === 0) {
      container.appendChild(createTextElement(documentRef, 'p', 'No recent incidents.', 'empty-state'));
      return;
    }
    for (const incident of incidents) {
      const card = documentRef.createElement('article');
      card.className = 'incident-card';
      card.appendChild(createTextElement(documentRef, 'h3', incident.message));
      const state = incident.state === 'resolved' ? 'Resolved' : 'Investigating';
      card.appendChild(createTextElement(
        documentRef,
        'p',
        `${state} · Updated ${malaysiaTime(incident.updatedAt)}`,
      ));
      container.appendChild(card);
    }
  }

  function renderUnavailable(documentRef) {
    documentRef.getElementById('overall-heading').textContent = 'Status information temporarily unavailable';
    const badge = documentRef.getElementById('overall-badge');
    badge.textContent = 'Unknown';
    badge.className = 'status-badge status-unknown';
    const notice = documentRef.getElementById('status-notice');
    notice.textContent = 'Current automated-check data could not be loaded. This is not an all-clear result.';
    notice.hidden = false;
    const time = documentRef.getElementById('generated-at');
    time.textContent = 'Unavailable';
    time.removeAttribute('datetime');
    renderComponents(documentRef, [{
      id: 'status-unavailable',
      label: 'Automated status checks',
      status: 'unknown',
      checkedAt: new Date(0).toISOString(),
      responseMs: 0,
    }]);
    documentRef.getElementById('components').lastChild.querySelector('.component-meta').textContent = 'Current check details are unavailable.';
    const incidents = documentRef.getElementById('incidents');
    replaceChildren(incidents);
    incidents.appendChild(createTextElement(documentRef, 'p', 'Incident history is temporarily unavailable.', 'empty-state'));
  }

  function renderStatus(documentRef, payload, { nowMs = Date.now() } = {}) {
    const stale = nowMs - Date.parse(payload.generatedAt) > STALE_AFTER_MS;
    const heading = documentRef.getElementById('overall-heading');
    const badge = documentRef.getElementById('overall-badge');
    const notice = documentRef.getElementById('status-notice');

    if (stale) {
      heading.textContent = 'Status data is delayed';
      badge.textContent = 'Degraded';
      badge.className = 'status-badge status-degraded';
      notice.textContent = 'Status information may be stale and must not be treated as a current all-clear.';
      notice.hidden = false;
    } else {
      heading.textContent = payload.overallStatus;
      const overallClass = payload.overallStatus === 'Operational'
        ? 'operational'
        : payload.overallStatus === 'Major Outage' || payload.overallStatus === 'Partial Outage'
          ? 'outage'
          : 'degraded';
      badge.textContent = payload.overallStatus;
      badge.className = `status-badge status-${overallClass}`;
      notice.textContent = 'Status is based on bounded anonymous checks of public pages.';
      notice.hidden = false;
    }

    setGeneratedAt(documentRef, payload.generatedAt);
    renderComponents(documentRef, payload.components);
    renderIncidents(documentRef, payload.incidents);
    return { stale };
  }

  async function loadAndRender({
    documentRef = root.document,
    fetchImpl = root.fetch,
    now = () => Date.now(),
  } = {}) {
    try {
      const response = await fetchImpl('status.json', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > MAX_STATUS_BYTES)) {
        throw new Error('Status unavailable.');
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_STATUS_BYTES) throw new Error('Status unavailable.');
      const payload = validateStatusPayload(JSON.parse(text));
      if (!payload) throw new Error('Status unavailable.');
      return renderStatus(documentRef, payload, { nowMs: now() });
    } catch {
      renderUnavailable(documentRef);
      return { unavailable: true };
    }
  }

  const api = {
    MAX_STATUS_BYTES,
    STALE_AFTER_MS,
    loadAndRender,
    renderStatus,
    renderUnavailable,
    validateStatusPayload,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AlafSanjungStatus = api;
  if (root?.document) {
    root.document.addEventListener('DOMContentLoaded', () => {
      loadAndRender();
    });
  }
}(typeof globalThis === 'object' ? globalThis : this));
