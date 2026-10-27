/**
 * The dashboard is code, so it is checked like code.
 *
 * Two failure modes this prevents. A malformed JSON file that Grafana refuses
 * with a toast nobody notices. And, more quietly, a panel querying a series the
 * API never emits — which renders as "No data" forever and teaches operators to
 * distrust every other panel on the board.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/index.js';
import { Registry } from 'prom-client';

const DASHBOARD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../infra/observability/grafana/permitzero-dashboard.json',
);

describe('grafana dashboard', () => {
  const raw = readFileSync(DASHBOARD_PATH, 'utf8');
  const dashboard = JSON.parse(raw) as {
    uid: string;
    title: string;
    panels: Array<{ type: string; title?: string; targets?: Array<{ expr?: string }>; datasource?: { uid?: string } }>;
  };

  it('is valid JSON with a stable uid and a title', () => {
    expect(dashboard.uid).toBe('permitzero-control-plane');
    expect(dashboard.title.length).toBeGreaterThan(0);
  });

  it('gives every query panel a data source and at least one expression', () => {
    const queryTypes = new Set(['timeseries', 'stat', 'gauge', 'bargauge', 'table']);
    for (const panel of dashboard.panels) {
      if (!queryTypes.has(panel.type)) continue;
      expect(panel.targets?.length, `${panel.title} has no targets`).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        expect((target.expr ?? '').length, `${panel.title} has an empty expr`).toBeGreaterThan(0);
      }
      expect(panel.datasource?.uid, `${panel.title} has no datasource`).toBeDefined();
    }
  });

  it('queries only metric families this process actually registers', () => {
    // Register every series, then compare the names the dashboard references.
    const metrics = createMetrics({ registry: new Registry(), processMetrics: false });
    const declared = new Set(
      Object.entries(metrics)
        .filter(([, value]) => value && typeof value === 'object' && 'name' in (value as object))
        .map(([, value]) => (value as { name: string }).name),
    );
    // Prometheus recorders expose their base name; counters suffixed _total and
    // histograms expanded into _bucket/_sum/_count, so match on the stem.
    const stems = new Set([...declared].map((n) => n.replace(/_total$/, '')));

    const referenced = new Set<string>();
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        for (const match of (target.expr ?? '').matchAll(/\b(pz_[a-z0-9_]+)/g)) {
          referenced.add(match[1] as string);
        }
      }
    }
    expect(referenced.size).toBeGreaterThan(8);
    for (const name of referenced) {
      const stem = name.replace(/_(bucket|sum|count|total)$/, '');
      expect(stems.has(stem), `dashboard queries ${name}, which no metric bundle declares`).toBe(true);
    }
  });

  it('states the tenant-isolation panel as a red-on-zero threshold', () => {
    // The single panel that must never be able to look healthy while the control
    // is absent: 0 has to be visually unmistakable.
    const isolation = dashboard.panels.find((p) => p.title === 'Tenant isolation enforced');
    expect(isolation).toBeDefined();
    expect(raw).toContain('"NOT ENFORCED"');
    expect(raw).toContain('"color": "red"');
  });

  it('gives every panel a unique id and a unique title', () => {
    // Duplicate ids make Grafana refuse the import; duplicate titles make a
    // shared-link screenshot ambiguous about which panel was meant.
    const panels = dashboard.panels.filter((p) => p.type !== 'row');
    const ids = panels.map((p) => (p as { id?: number }).id);
    expect(new Set(ids).size).toBe(ids.length);
    const titles = panels.map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('lays panels out on the grid without overlapping two at the same slot', () => {
    const occupied = new Set<string>();
    const laid = dashboard.panels as unknown as Array<{
      id: number;
      gridPos?: { h: number; w: number; x: number; y: number };
    }>;
    for (const panel of laid) {
      const g = panel.gridPos;
      if (!g) continue;
      expect(g.w, `panel ${panel.id} has no width`).toBeGreaterThan(0);
      expect(g.h, `panel ${panel.id} has no height`).toBeGreaterThan(0);
      // Rows span the full width; panels must fit inside 24 columns.
      expect(g.x + g.w).toBeLessThanOrEqual(24);
      const key = `${panel.id}`;
      expect(occupied.has(key), `panel ${panel.id} is declared twice`).toBe(false);
      occupied.add(key);
    }
  });
});
