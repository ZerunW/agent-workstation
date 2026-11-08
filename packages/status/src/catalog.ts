/** Metric naming conventions shared by collector, store and API. */

const SUFFIX_UNITS: Array<[string, string]> = [
  ["_pct", "%"],
  ["_bytes", "bytes"],
  ["_bps", "bytes/s"],
  ["_mbps", "Mbps"],
  ["_c", "°C"],
  ["_ms", "ms"],
  ["_s", "s"],
];

/** Unit string for a metric, derived from its name suffix. Empty for unitless numbers (load, counts). */
export function metricUnit(name: string): string {
  for (const [suffix, unit] of SUFFIX_UNITS) if (name.endsWith(suffix)) return unit;
  return "";
}
